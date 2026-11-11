//! Read-only preflight for Mutter's portal keysym route. No surfaces or input
//! devices are created. A background Wayland client cannot establish the active
//! layout group, so every configured group must support the complete text.

use anyhow::{bail, Context, Result};
use std::{
    collections::HashMap,
    env,
    ffi::CString,
    fs::File,
    io,
    os::fd::{AsRawFd, OwnedFd},
    os::unix::fs::FileExt,
    path::PathBuf,
    ptr::NonNull,
    time::{Duration, Instant},
};
use wayland_client::{
    protocol::{wl_callback, wl_keyboard, wl_registry, wl_seat},
    Connection, Dispatch, QueueHandle, WEnum,
};
use xkbcommon_dl as xkb;

const READ_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_KEYMAP_BYTES: u32 = 1024 * 1024;

pub(crate) async fn validate_gnome_text(text: &str, keysyms: &[i32]) -> Result<()> {
    if text.is_empty() {
        return Ok(());
    }
    let text = text.to_string();
    let keysyms = keysyms.to_vec();
    tokio::task::spawn_blocking(move || {
        let deadline = Instant::now() + READ_TIMEOUT;
        let bytes = read_keymap(deadline)?;
        let keymap = Keymap::parse(bytes)?;
        let groups = keymap.first_levels(deadline)?;
        validate_groups(&text, &keysyms, &groups)
    })
    .await
    .context("keyboard keymap preflight failed")?
}

#[derive(Default)]
struct Reader {
    registry_done: bool,
    seats: Vec<wl_seat::WlSeat>,
    keyboard: Option<wl_keyboard::WlKeyboard>,
    keymap: Option<Result<Vec<u8>>>,
}

fn read_keymap(deadline: Instant) -> Result<Vec<u8>> {
    // Do not consume WAYLAND_SOCKET: this is a separate, short-lived read-only
    // connection, not the owning client's inherited connection.
    let display = PathBuf::from(
        env::var_os("WAYLAND_DISPLAY")
            .context("WAYLAND_DISPLAY is missing; cannot verify the keyboard keymap")?,
    );
    let path = if display.is_absolute() {
        display
    } else {
        let runtime = PathBuf::from(
            env::var_os("XDG_RUNTIME_DIR")
                .context("XDG_RUNTIME_DIR is missing; cannot verify the keyboard keymap")?,
        );
        if !runtime.is_absolute() {
            bail!("XDG_RUNTIME_DIR must be absolute to verify the keyboard keymap");
        }
        runtime.join(display)
    };
    let stream = crate::x11_display::connect_unix(
        path.to_str().context("Wayland socket path is not UTF-8")?,
        deadline,
    )
    .context("cannot connect to Wayland to verify the keyboard keymap")?;
    let conn =
        Connection::from_socket(stream).context("cannot initialize Wayland keymap reader")?;
    let mut queue = conn.new_event_queue::<Reader>();
    let qh = queue.handle();
    let _registry = conn.display().get_registry(&qh, ());
    conn.display().sync(&qh, ());
    let mut state = Reader::default();
    loop {
        check_deadline(deadline)?;
        queue.dispatch_pending(&mut state)?;
        if state.registry_done {
            if state.seats.len() != 1 {
                bail!("cannot verify a keyboard keymap without exactly one Wayland seat; use set_value on an editable field");
            }
            if let Some(keymap) = state.keymap.take() {
                return keymap;
            }
        }
        // The messages are tiny. A full outgoing socket fails promptly instead
        // of waiting beyond the shared deadline.
        queue
            .flush()
            .context("cannot request the Wayland keyboard keymap")?;
        if let Some(guard) = queue.prepare_read() {
            let mut fd = libc::pollfd {
                fd: guard.connection_fd().as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let remaining = deadline.saturating_duration_since(Instant::now());
            let millis = i32::try_from(remaining.as_millis())
                .unwrap_or(i32::MAX)
                .max(1);
            // SAFETY: fd describes one live Wayland connection for this call.
            let status = unsafe { libc::poll(&mut fd, 1, millis) };
            if status == 0 {
                bail!("keyboard keymap read timed out; no text was sent");
            }
            if status < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error).context("keyboard keymap read failed");
            }
            guard
                .read()
                .context("Wayland keyboard keymap read failed")?;
        }
    }
}

fn check_deadline(deadline: Instant) -> Result<()> {
    if Instant::now() >= deadline {
        bail!("keyboard keymap preflight timed out; no text was sent");
    }
    Ok(())
}

impl Dispatch<wl_registry::WlRegistry, ()> for Reader {
    fn event(
        state: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let wl_registry::Event::Global {
            name,
            interface,
            version,
        } = event
        {
            // Two seats are enough to reject ambiguous device selection.
            if interface == "wl_seat" && state.seats.len() < 2 {
                state
                    .seats
                    .push(registry.bind(name, version.min(7), qh, ()));
            }
        }
    }
}

impl Dispatch<wl_callback::WlCallback, ()> for Reader {
    fn event(
        state: &mut Self,
        _: &wl_callback::WlCallback,
        _: wl_callback::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        state.registry_done = true;
    }
}

impl Dispatch<wl_seat::WlSeat, ()> for Reader {
    fn event(
        state: &mut Self,
        seat: &wl_seat::WlSeat,
        event: wl_seat::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let wl_seat::Event::Capabilities {
            capabilities: WEnum::Value(capabilities),
        } = event
        {
            if state.keyboard.is_none() && capabilities.contains(wl_seat::Capability::Keyboard) {
                state.keyboard = Some(seat.get_keyboard(qh, ()));
            }
        }
    }
}

impl Dispatch<wl_keyboard::WlKeyboard, ()> for Reader {
    fn event(
        state: &mut Self,
        _: &wl_keyboard::WlKeyboard,
        event: wl_keyboard::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_keyboard::Event::Keymap { format, fd, size } = event {
            state.keymap = Some(
                if format == WEnum::Value(wl_keyboard::KeymapFormat::XkbV1) {
                    read_keymap_file(fd, size)
                } else {
                    Err(anyhow::anyhow!(
                        "Wayland keyboard keymap is not XKB text format"
                    ))
                },
            );
        }
    }
}

fn read_keymap_file(fd: OwnedFd, size: u32) -> Result<Vec<u8>> {
    if size == 0 || size > MAX_KEYMAP_BYTES {
        bail!("Wayland keyboard keymap exceeds the 1 MiB read limit or is empty");
    }
    let file = File::from(fd);
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() < u64::from(size) {
        bail!("Wayland keyboard keymap is not a complete regular file");
    }
    let mut bytes = vec![0; size as usize];
    file.read_exact_at(&mut bytes, 0)
        .context("Wayland keyboard keymap was truncated")?;
    Ok(bytes)
}

struct Keymap {
    api: &'static xkb::XkbCommon,
    context: NonNull<xkb::xkb_context>,
    map: NonNull<xkb::xkb_keymap>,
}

impl Keymap {
    fn parse(bytes: Vec<u8>) -> Result<Self> {
        let api = xkb::xkbcommon_option()
            .context("libxkbcommon is unavailable; cannot verify literal text")?;
        let text = CString::from_vec_with_nul(bytes)
            .context("keyboard keymap has invalid string framing")?;
        // SAFETY: all calls use live objects and a NUL-terminated keymap. The
        // RAII owner below releases both objects, including parse failure.
        unsafe {
            let context = NonNull::new((api.xkb_context_new)(
                xkb::xkb_context_flags::XKB_CONTEXT_NO_DEFAULT_INCLUDES,
            ))
            .context("cannot allocate XKB context")?;
            let map = (api.xkb_keymap_new_from_string)(
                context.as_ptr(),
                text.as_ptr(),
                xkb::xkb_keymap_format::XKB_KEYMAP_FORMAT_TEXT_V1,
                xkb::xkb_keymap_compile_flags::XKB_KEYMAP_COMPILE_NO_FLAGS,
            );
            let Some(map) = NonNull::new(map) else {
                (api.xkb_context_unref)(context.as_ptr());
                bail!("cannot parse the Wayland keyboard keymap");
            };
            Ok(Self { api, context, map })
        }
    }

    fn first_levels(&self, deadline: Instant) -> Result<Vec<HashMap<u32, u32>>> {
        // Mutter resolves the first matching keycode/level in the active
        // group. Preserve that ordering, including unsupported higher levels.
        // SAFETY: self owns a live immutable keymap; returned symbol slices are
        // borrowed only until the next call and bounded by libxkbcommon's count.
        unsafe {
            let map = self.map.as_ptr();
            let groups = (self.api.xkb_keymap_num_layouts)(map);
            let min = (self.api.xkb_keymap_min_keycode)(map);
            let max = (self.api.xkb_keymap_max_keycode)(map);
            if groups == 0 || groups > 16 || max > 65535 || min > max {
                bail!("keyboard keymap exceeds supported layout/keycode limits");
            }
            let mut result = Vec::new();
            for group in 0..groups {
                let mut first = HashMap::new();
                // Mutter's legacy lookup excludes the upper bound too.
                for key in min..max {
                    check_deadline(deadline)?;
                    let levels = (self.api.xkb_keymap_num_levels_for_key)(map, key, group);
                    if levels > 32 {
                        bail!("keyboard keymap exceeds supported level limits");
                    }
                    for level in 0..levels {
                        let mut syms = std::ptr::null();
                        let count = (self.api.xkb_keymap_key_get_syms_by_level)(
                            map, key, group, level, &mut syms,
                        );
                        if !(0..=32).contains(&count) || (count > 0 && syms.is_null()) {
                            bail!("keyboard keymap returned an invalid symbol list");
                        }
                        if count > 0 {
                            for &sym in std::slice::from_raw_parts(syms, count as usize) {
                                first.entry(sym).or_insert(level);
                            }
                        }
                    }
                }
                result.push(first);
            }
            Ok(result)
        }
    }
}

impl Drop for Keymap {
    fn drop(&mut self) {
        // SAFETY: these are the owned references constructed by parse.
        unsafe {
            (self.api.xkb_keymap_unref)(self.map.as_ptr());
            (self.api.xkb_context_unref)(self.context.as_ptr());
        }
    }
}

/// The preflight refused the text because a configured layout group cannot
/// type one of its characters. No key was sent. Callers can tell this refusal
/// from a keymap that could not be read with `downcast_ref`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MissingLayoutKeysym {
    pub(crate) ch: char,
    /// One-based layout group number.
    pub(crate) group: usize,
    pub(crate) reason: MissingKeysymReason,
}

/// Why a layout group cannot type a character.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MissingKeysymReason {
    /// No key in the group produces it.
    Absent,
    /// A key produces it only at a shift level Mutter cannot synthesize.
    UnreachableLevel,
}

impl MissingLayoutKeysym {
    /// "keyboard layout group 2 lacks U+0068", or the unreachable-level
    /// wording.
    pub(crate) fn summary(&self) -> String {
        match self.reason {
            MissingKeysymReason::Absent => format!(
                "keyboard layout group {} lacks U+{:04X}",
                self.group, self.ch as u32
            ),
            MissingKeysymReason::UnreachableLevel => format!(
                "keyboard layout group {} has U+{:04X} only at a shift level the portal cannot type",
                self.group, self.ch as u32
            ),
        }
    }
}

impl std::fmt::Display for MissingLayoutKeysym {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "GNOME portal cannot verify U+{:04X} in keyboard layout group {}: the {}. A background client cannot verify the active group, so every group must support the complete text. No text was sent; use set_value on an editable field.", self.ch as u32, self.group, match self.reason {
            MissingKeysymReason::Absent => "group has no key for it",
            MissingKeysymReason::UnreachableLevel => "group has it only at a shift level the portal cannot type",
        })
    }
}

impl std::error::Error for MissingLayoutKeysym {}

fn validate_groups(text: &str, keysyms: &[i32], groups: &[HashMap<u32, u32>]) -> Result<()> {
    if groups.is_empty() || text.chars().count() != keysyms.len() {
        bail!("cannot verify the complete text against the keyboard keymap");
    }
    for (ch, &keysym) in text.chars().zip(keysyms) {
        for (index, group) in groups.iter().enumerate() {
            let reason = match group.get(&(keysym as u32)) {
                None => Some(MissingKeysymReason::Absent),
                Some(0) => None,
                Some(1) if group.get(&xkeysym::key::Shift_L) == Some(&0) => None,
                Some(2) if group.get(&xkeysym::key::ISO_Level3_Shift) == Some(&0) => None,
                Some(_) => Some(MissingKeysymReason::UnreachableLevel),
            };
            if let Some(reason) = reason {
                return Err(MissingLayoutKeysym {
                    ch,
                    group: index + 1,
                    reason,
                }
                .into());
            }
        }
    }
    Ok(())
}

/// The preflight against a keymap fixture instead of the live Wayland one.
#[cfg(test)]
pub(crate) fn validate_text_with_keymap(keymap: &[u8], text: &str) -> Result<()> {
    let mut bytes = keymap.to_vec();
    bytes.push(0);
    let map = Keymap::parse(bytes)?;
    let groups = map.first_levels(Instant::now() + READ_TIMEOUT)?;
    let keysyms = crate::remote_desktop::keysyms_for_text(text)?;
    validate_groups(text, &keysyms, &groups)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_xkb_fixture_rejects_dead_only_symbols_in_another_group() {
        let mut bytes = include_bytes!("../tests/fixtures/keyboard-us-de.xkb").to_vec();
        bytes.push(0);
        let map = Keymap::parse(bytes).expect("parse the self-contained XKB fixture");
        let groups = map.first_levels(Instant::now() + READ_TIMEOUT).unwrap();
        assert_eq!(groups.len(), 2);
        assert!(validate_groups(
            "aA",
            &[xkeysym::key::a as i32, xkeysym::key::A as i32],
            &groups
        )
        .is_ok());
        assert!(validate_groups(
            "a`",
            &[xkeysym::key::a as i32, xkeysym::key::grave as i32],
            &groups
        )
        .unwrap_err()
        .to_string()
        .contains("group 2"));
        assert!(validate_groups("א", &[xkeysym::key::hebrew_aleph as i32], &groups).is_err());
    }

    #[test]
    fn rejects_complete_text_when_any_group_or_level_is_unsupported() {
        let latin = HashMap::from([
            (xkeysym::key::a, 0),
            (xkeysym::key::asciicircum, 1),
            (xkeysym::key::Shift_L, 0),
        ]);
        let german = HashMap::from([(xkeysym::key::a, 0), (xkeysym::key::dead_circumflex, 0)]);
        assert!(validate_groups(
            "a^",
            &[xkeysym::key::a as i32, xkeysym::key::asciicircum as i32],
            std::slice::from_ref(&latin)
        )
        .is_ok());
        let error = validate_groups(
            "a^",
            &[xkeysym::key::a as i32, xkeysym::key::asciicircum as i32],
            &[latin, german],
        )
        .unwrap_err();
        assert!(error.to_string().contains("U+005E"));
        assert!(error.to_string().contains("group 2"));
        assert_eq!(
            error.downcast_ref::<MissingLayoutKeysym>(),
            Some(&MissingLayoutKeysym {
                ch: '^',
                group: 2,
                reason: MissingKeysymReason::Absent,
            })
        );
        assert!(error.to_string().contains("has no key for it"), "{error}");
        let unsupported_level = HashMap::from([(xkeysym::key::a, 3)]);
        let missing_modifier = HashMap::from([(xkeysym::key::a, 1)]);
        for group in [unsupported_level, missing_modifier] {
            let error = validate_groups("a", &[xkeysym::key::a as i32], &[group]).unwrap_err();
            let missing = *error.downcast_ref::<MissingLayoutKeysym>().unwrap();
            assert_eq!(missing.reason, MissingKeysymReason::UnreachableLevel);
            assert!(
                error.to_string().contains("only at a shift level"),
                "{error}"
            );
            assert!(missing.summary().contains("only at a shift level"));
            assert!(!missing.summary().contains("lacks"));
        }
        // Only a missing keysym is a layout refusal. A keymap the preflight
        // cannot check must not look like one.
        assert!(validate_groups("a", &[xkeysym::key::a as i32], &[])
            .unwrap_err()
            .downcast_ref::<MissingLayoutKeysym>()
            .is_none());
    }
}
