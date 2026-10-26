//! Large accessibility trees go to a private file instead of the tool result.
//!
//! A big Electron or browser tree serializes to megabytes, far past what an MCP
//! host shows a model (Codex cuts tool output at 10,000 tokens). Past the
//! inline budget a result keeps only the nodes that fit, and the whole
//! compacted tree is written as JSON to a private per-user directory the agent
//! can search; hosts without file access page through it with
//! `get_tree_page`. Indices in the file match the cached snapshot, so an
//! `element_index` read from it still works.
//!
//! A file exists only while it matches the cache: the server removes it
//! whenever it caches a new snapshot, when a new spill replaces it, and when it
//! exits (stdin closed, SIGTERM or SIGINT). Files of servers that are gone are
//! swept at startup and on every spill, and any file older than an hour.

use std::fs::{self, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use schemars::JsonSchema;
use serde::Serialize;

use crate::atspi_tree::AccessibilityNode;

/// Largest whole tool result, in serialized bytes, before the tree is spilled.
/// It keeps a result inside a 10,000-token host limit (about 40,000 bytes of
/// JSON), with room for a note about the spill.
pub(crate) const INLINE_RESULT_BYTES: usize = 32_000;
/// A spill file older than this is swept even if its server still runs.
const MAX_SPILL_AGE: Duration = Duration::from_secs(60 * 60);
const SPILL_PREFIX: &str = "tree-";

/// Where the full tree went when it was too large to return inline.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub(crate) struct TreeSpill {
    /// JSON array of every compacted node, with the same indices as the cached snapshot.
    pub path: String,
    /// Nodes in the file.
    pub node_count: usize,
    /// File size in bytes.
    pub bytes: usize,
    /// Nodes returned inline, from the start of the tree.
    pub inline_node_count: usize,
}

/// One server's spill file.
pub(crate) struct TreeSpiller {
    dir: Option<PathBuf>,
    /// Start time of this process, so a leftover file from an earlier process
    /// that had the same pid is not mistaken for this server's.
    start: u64,
    current: Mutex<Option<PathBuf>>,
    sequence: AtomicU64,
}

impl Default for TreeSpiller {
    fn default() -> Self {
        Self::new(spill_dir())
    }
}

impl TreeSpiller {
    pub(crate) fn new(dir: Option<PathBuf>) -> Self {
        Self {
            dir,
            start: process_start(std::process::id()).unwrap_or_default(),
            current: Mutex::new(None),
            sequence: AtomicU64::new(0),
        }
    }

    /// Fit `nodes` into `budget` bytes. When they do not fit, write all of them
    /// to a spill file and keep the prefix that fits. Without a usable spill
    /// directory the tree is cut to the prefix and `Err` says why. Call right
    /// after the snapshot is cached, with no await in between, so the file and
    /// the cache stay paired.
    pub(crate) fn fit(
        &self,
        nodes: &mut Vec<AccessibilityNode>,
        budget: usize,
    ) -> Result<Option<TreeSpill>, (usize, String)> {
        let inline = inline_prefix_len(nodes, budget);
        if inline == nodes.len() {
            return Ok(None);
        }
        let result = self.write(nodes).map(|(path, bytes)| TreeSpill {
            path: path.display().to_string(),
            node_count: nodes.len(),
            bytes,
            inline_node_count: inline,
        });
        nodes.truncate(inline);
        result
            .map(Some)
            .map_err(|error| (inline, format!("{error:#}")))
    }

    fn write(&self, nodes: &[AccessibilityNode]) -> io::Result<(PathBuf, usize)> {
        let dir = self.dir.as_deref().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "no private directory for spilled trees",
            )
        })?;
        ensure_private_dir(dir)?;
        sweep(dir, std::process::id(), self.start);
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!(
            "{SPILL_PREFIX}{}-{}-{sequence}.json",
            std::process::id(),
            self.start
        ));
        let written = (|| {
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&path)?;
            let mut writer = BufWriter::new(file);
            serde_json::to_writer(&mut writer, nodes)?;
            writer.flush()?;
            Ok::<_, io::Error>(writer.get_ref().metadata()?.len() as usize)
        })();
        let bytes = match written {
            Ok(bytes) => bytes,
            Err(error) => {
                let _ = fs::remove_file(&path);
                return Err(error);
            }
        };
        let previous = self
            .current
            .lock()
            .ok()
            .and_then(|mut current| current.replace(path.clone()));
        if let Some(previous) = previous {
            let _ = fs::remove_file(previous);
        }
        Ok((path, bytes))
    }

    /// Remove this server's spill file, if any. Called whenever the cached
    /// snapshot changes, so a file never outlives the snapshot it matches.
    pub(crate) fn remove_current(&self) {
        if let Some(path) = self
            .current
            .lock()
            .ok()
            .and_then(|mut current| current.take())
        {
            let _ = fs::remove_file(path);
        }
    }

    /// Remove files left by servers that are gone, or that are too old.
    pub(crate) fn sweep(&self) {
        if let Some(dir) = &self.dir {
            if private_dir(dir).is_ok() {
                sweep(dir, std::process::id(), self.start);
            }
        }
    }
}

impl Drop for TreeSpiller {
    fn drop(&mut self) {
        self.remove_current();
    }
}

/// `$XDG_RUNTIME_DIR/codex-computer-use-linux/trees` when the runtime directory is
/// the user's own and private (as the XDG spec requires); otherwise
/// `$XDG_CACHE_HOME` or `~/.cache`, under `codex-computer-use-linux/trees`.
fn spill_dir() -> Option<PathBuf> {
    let leaf = |base: PathBuf| base.join("codex-computer-use-linux").join("trees");
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && private_dir(path).is_ok());
    if let Some(runtime) = runtime {
        return Some(leaf(runtime));
    }
    std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .map(leaf)
}

/// A real directory, owned by this user, with no group or other access.
fn private_dir(path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} is not a directory", path.display()),
        ));
    }
    // SAFETY: geteuid has no preconditions and cannot fail.
    if meta.uid() != unsafe { libc::geteuid() } {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{} is owned by another user", path.display()),
        ));
    }
    if meta.permissions().mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{} is open to other users", path.display()),
        ));
    }
    Ok(())
}

/// Create the spill directory and its `codex-computer-use-linux` parent as private
/// directories, or check existing ones: never a symlink, another user's
/// directory, or one others can write.
fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    let parent = dir.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "spill directory has no parent")
    })?;
    for path in [parent, dir] {
        match fs::symlink_metadata(path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if let Some(base) = path.parent() {
                    fs::create_dir_all(base)?;
                }
                fs::DirBuilder::new().mode(0o700).create(path)?;
            }
            Err(error) => return Err(error),
            Ok(_) => {}
        }
        private_dir(path)?;
    }
    Ok(())
}

/// Number of leading nodes whose JSON array fits in `budget` bytes.
pub(crate) fn inline_prefix_len(nodes: &[AccessibilityNode], budget: usize) -> usize {
    let mut used: usize = 2; // the array brackets
    for (index, node) in nodes.iter().enumerate() {
        let size = serde_json::to_string(node).map_or(usize::MAX, |json| json.len())
            + usize::from(index > 0);
        if used.saturating_add(size) > budget {
            return index;
        }
        used += size;
    }
    nodes.len()
}

/// Remove spill files whose server is gone (its pid is not running with the
/// recorded start time), or that are older than [`MAX_SPILL_AGE`].
fn sweep(dir: &Path, own_pid: u32, own_start: u64) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some((pid, start)) = name.to_str().and_then(spill_file_owner) else {
            continue;
        };
        let old = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > MAX_SPILL_AGE);
        let own = pid == own_pid && start == own_start;
        let alive = own || process_start(pid) == Some(start);
        if old || !alive {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// `(pid, start time)` from a `tree-<pid>-<start>-<seq>.json` name.
fn spill_file_owner(name: &str) -> Option<(u32, u64)> {
    let mut parts = name
        .strip_prefix(SPILL_PREFIX)?
        .strip_suffix(".json")?
        .split('-');
    let pid = parts.next()?.parse().ok()?;
    let start = parts.next()?.parse().ok()?;
    parts.next()?.parse::<u64>().ok()?;
    parts.next().is_none().then_some((pid, start))
}

/// Start time of `pid` in clock ticks since boot (`/proc/<pid>/stat` field 22).
fn process_start(pid: u32) -> Option<u64> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command name can contain spaces and parentheses; fields follow the last ')'.
    stat.rsplit_once(')')?
        .1
        .split_whitespace()
        .nth(19)?
        .parse()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(index: u32, name_len: usize) -> AccessibilityNode {
        AccessibilityNode {
            index,
            parent_index: index.checked_sub(1),
            depth: index,
            object_ref: format!(":1.1/org/a11y/atspi/accessible/{index}"),
            role: "paragraph".into(),
            name: Some("x".repeat(name_len)),
            description: None,
            child_count: 0,
            bounds: None,
            states: Vec::new(),
            actions: Vec::new(),
            value: None,
            text: None,
            supports_editable_text: false,
        }
    }

    fn big_tree() -> Vec<AccessibilityNode> {
        (0..200).map(|i| node(i, 400)).collect()
    }

    /// A private scratch directory; the spill directory is `<scratch>/cul/trees`.
    fn scratch(name: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("cul-spill-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&root)
            .unwrap();
        let dir = root.join("cul").join("trees");
        (root, dir)
    }

    fn files(dir: &Path) -> Vec<PathBuf> {
        fs::read_dir(dir).map_or_else(|_| Vec::new(), |d| d.flatten().map(|e| e.path()).collect())
    }

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn small_trees_stay_inline_and_write_nothing() {
        let (root, dir) = scratch("small");
        let spiller = TreeSpiller::new(Some(dir.clone()));
        let mut nodes = vec![node(0, 10), node(1, 10)];
        assert!(matches!(
            spiller.fit(&mut nodes, INLINE_RESULT_BYTES),
            Ok(None)
        ));
        assert_eq!(nodes.len(), 2);
        assert!(files(&dir).is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn large_trees_spill_whole_and_keep_a_prefix_that_fits() {
        let (root, dir) = scratch("large");
        let spiller = TreeSpiller::new(Some(dir.clone()));
        let mut nodes = big_tree();
        let spill = spiller
            .fit(&mut nodes, INLINE_RESULT_BYTES)
            .unwrap()
            .expect("spilled");
        assert_eq!(
            (spill.node_count, spill.inline_node_count),
            (200, nodes.len())
        );
        assert!(serde_json::to_string(&nodes).unwrap().len() <= INLINE_RESULT_BYTES);
        assert!(!nodes.is_empty() && nodes.len() < 200);
        let written: Vec<serde_json::Value> =
            serde_json::from_slice(&fs::read(&spill.path).unwrap()).unwrap();
        assert_eq!(written.len(), 200);
        assert_eq!(
            (
                mode(Path::new(&spill.path)),
                mode(&dir),
                mode(dir.parent().unwrap())
            ),
            (0o600, 0o700, 0o700)
        );
        drop(spiller);
        assert!(
            !Path::new(&spill.path).exists(),
            "the server removes its file on exit"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_new_spill_replaces_the_previous_one_and_a_new_snapshot_removes_it() {
        let (root, dir) = scratch("replace");
        let spiller = TreeSpiller::new(Some(dir.clone()));
        let first = spiller
            .fit(&mut big_tree(), INLINE_RESULT_BYTES)
            .unwrap()
            .unwrap();
        let second = spiller
            .fit(&mut big_tree(), INLINE_RESULT_BYTES)
            .unwrap()
            .unwrap();
        assert!(!Path::new(&first.path).exists());
        assert_eq!(files(&dir), vec![PathBuf::from(&second.path)]);
        spiller.remove_current();
        assert!(
            files(&dir).is_empty(),
            "a newly cached snapshot removes the file"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn sweep_keeps_live_servers_and_removes_gone_or_reused_pids() {
        let (root, dir) = scratch("sweep");
        ensure_private_dir(&dir).unwrap();
        let me = std::process::id();
        let my_start = process_start(me).unwrap();
        let init_start = process_start(1).unwrap();
        let live_other = dir.join(format!("{SPILL_PREFIX}1-{init_start}-0.json"));
        let mine = dir.join(format!("{SPILL_PREFIX}{me}-{my_start}-0.json"));
        // Same pid as this process, but an earlier process's start time: a leftover.
        let reused = dir.join(format!(
            "{SPILL_PREFIX}{me}-{}-0.json",
            my_start.wrapping_sub(1)
        ));
        let gone = dir.join(format!("{SPILL_PREFIX}0-5-3.json"));
        let unrelated = dir.join("notes.txt");
        for path in [&live_other, &mine, &reused, &gone, &unrelated] {
            fs::write(path, "[]").unwrap();
        }
        sweep(&dir, me, my_start);
        assert!(live_other.exists() && mine.exists() && unrelated.exists());
        assert!(!reused.exists() && !gone.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn sweep_removes_files_older_than_an_hour() {
        let (root, dir) = scratch("age");
        ensure_private_dir(&dir).unwrap();
        let me = std::process::id();
        let start = process_start(me).unwrap();
        let old = dir.join(format!("{SPILL_PREFIX}{me}-{start}-9.json"));
        fs::write(&old, "[]").unwrap();
        let past = SystemTime::now() - MAX_SPILL_AGE - Duration::from_secs(60);
        fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(past)
            .unwrap();
        sweep(&dir, me, start);
        assert!(!old.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_directory_others_can_write_is_refused() {
        let (root, dir) = scratch("shared");
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)
            .unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o777)).unwrap();
        let spiller = TreeSpiller::new(Some(dir.clone()));
        let mut nodes = big_tree();
        let (inline, error) = spiller.fit(&mut nodes, INLINE_RESULT_BYTES).unwrap_err();
        assert_eq!(nodes.len(), inline);
        assert!(error.contains("open to other users"), "{error}");
        assert!(files(&dir).is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_symlinked_directory_is_refused() {
        let (root, dir) = scratch("symlink");
        let elsewhere = root.join("elsewhere");
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&elsewhere)
            .unwrap();
        fs::DirBuilder::new()
            .mode(0o700)
            .create(dir.parent().unwrap())
            .unwrap();
        std::os::unix::fs::symlink(&elsewhere, &dir).unwrap();
        assert!(ensure_private_dir(&dir).is_err());
        assert!(files(&elsewhere).is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn without_a_spill_directory_the_tree_is_cut_and_says_why() {
        let spiller = TreeSpiller::new(None);
        let mut nodes = big_tree();
        let (inline, error) = spiller.fit(&mut nodes, INLINE_RESULT_BYTES).unwrap_err();
        assert_eq!(nodes.len(), inline);
        assert!(error.contains("no private directory"));
    }

    #[test]
    fn spill_names_carry_pid_and_start_time() {
        assert_eq!(spill_file_owner("tree-42-1234-7.json"), Some((42, 1234)));
        assert_eq!(spill_file_owner("tree-42-7.json"), None);
        assert_eq!(spill_file_owner("tree-42-1234-7-8.json"), None);
        assert_eq!(spill_file_owner("notes.json"), None);
    }
}
