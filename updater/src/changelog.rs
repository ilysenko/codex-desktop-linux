//! Parsing and selection of wrapper CHANGELOG.md entries.
//!
//! The wrapper keeps a Keep-a-Changelog style `CHANGELOG.md` with version
//! headers like `## [0.8.0] - 2026-05-16` and an `## [Unreleased]` section.
//! When a newer wrapper release is detected we surface the curated entries for
//! every version above the installed one (plus `[Unreleased]`). When the
//! installed version cannot be mapped to a header, the caller falls back to a
//! raw git commit-subject list instead.

/// A single changelog section: its version label and the body text beneath it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangelogSection {
    /// The label inside the brackets, e.g. `0.8.0` or `Unreleased`.
    pub version: String,
    /// The section body, trimmed of surrounding blank lines.
    pub body: String,
}

/// Parses a Keep-a-Changelog document into ordered sections.
///
/// Only `## [..]` headers are treated as section boundaries; the top-level
/// `# Changelog` title and any preamble before the first version header are
/// ignored. Section order matches the document (newest first by convention).
pub fn parse_changelog(markdown: &str) -> Vec<ChangelogSection> {
    let mut sections = Vec::new();
    let mut current: Option<(String, Vec<&str>)> = None;

    for line in markdown.lines() {
        if let Some(version) = parse_section_header(line) {
            if let Some((version, body)) = current.take() {
                sections.push(finish_section(version, body));
            }
            current = Some((version, Vec::new()));
        } else if let Some((_, body)) = current.as_mut() {
            body.push(line);
        }
    }

    if let Some((version, body)) = current.take() {
        sections.push(finish_section(version, body));
    }

    sections
}

fn finish_section(version: String, body: Vec<&str>) -> ChangelogSection {
    ChangelogSection {
        version,
        body: body.join("\n").trim().to_string(),
    }
}

/// Returns the label inside a `## [label]` header, if the line is one.
fn parse_section_header(line: &str) -> Option<String> {
    let rest = line.strip_prefix("## ")?.trim();
    let inner = rest.strip_prefix('[')?;
    let end = inner.find(']')?;
    Some(inner[..end].to_string())
}

/// Builds a human-readable changelog covering everything newer than the
/// installed version. Includes the `Unreleased` section (when non-empty) and
/// every released version strictly greater than `installed_version`.
///
/// Returns `None` when nothing newer is found (so the caller can fall back to a
/// git commit list), or when `installed_version` cannot be parsed as semver
/// (the version-to-header mapping is then unreliable).
pub fn sections_newer_than(
    sections: &[ChangelogSection],
    installed_version: &str,
) -> Option<String> {
    let installed = parse_semver(installed_version)?;

    let mut chunks = Vec::new();
    for section in sections {
        let include = if section.version.eq_ignore_ascii_case("unreleased") {
            !section.body.is_empty()
        } else {
            match parse_semver(&section.version) {
                Some(version) => version > installed,
                None => false,
            }
        };
        if include {
            chunks.push(format!("## {}\n\n{}", section.version, section.body));
        }
    }

    if chunks.is_empty() {
        None
    } else {
        Some(chunks.join("\n\n"))
    }
}

/// Parsed `MAJOR.MINOR.PATCH` triple used for changelog selection.
type SemVer = (u64, u64, u64);

/// Parses a `MAJOR.MINOR.PATCH` version, ignoring any `-pre`/`+build` suffix.
/// Returns `None` when the core triple is not three numeric components.
pub fn parse_semver(version: &str) -> Option<SemVer> {
    let core = version
        .trim()
        .trim_start_matches('v')
        .split(['-', '+'])
        .next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// True when `candidate` is a strictly greater semver than `installed`.
/// Falsey (including equal or unparseable) otherwise. Retained as part of the
/// changelog public API for callers comparing wrapper versions directly.
#[allow(dead_code)]
pub fn semver_newer(candidate: &str, installed: &str) -> bool {
    match (parse_semver(candidate), parse_semver(installed)) {
        (Some(candidate), Some(installed)) => candidate > installed,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
# Changelog

All notable changes are documented here.

## [Unreleased]

### Added

- A brand new thing.

## [0.8.0] - 2026-05-16

### Added

- Remote control UI.

## [0.7.1] - 2026-05-06

### Fixed

- A path bug.
";

    #[test]
    fn parses_sections_in_order() {
        let sections = parse_changelog(SAMPLE);
        let labels: Vec<_> = sections.iter().map(|s| s.version.as_str()).collect();
        assert_eq!(labels, ["Unreleased", "0.8.0", "0.7.1"]);
        assert!(sections[1].body.contains("Remote control UI"));
        // The top-level "# Changelog" title and preamble are not a section.
        assert!(!sections[0].body.contains("All notable changes"));
    }

    #[test]
    fn selects_versions_newer_than_installed() {
        let sections = parse_changelog(SAMPLE);
        let newer = sections_newer_than(&sections, "0.7.1").expect("has newer");
        assert!(newer.contains("## Unreleased"));
        assert!(newer.contains("## 0.8.0"));
        assert!(newer.contains("Remote control UI"));
        // 0.7.1 equals installed, so it must not appear.
        assert!(!newer.contains("## 0.7.1"));
    }

    #[test]
    fn returns_none_when_nothing_newer() {
        let sections = parse_changelog("## [0.8.0] - 2026-05-16\n\n### Fixed\n\n- Old fix.\n");
        assert_eq!(sections_newer_than(&sections, "0.8.0"), None);
    }

    #[test]
    fn unreleased_only_included_when_non_empty() {
        let sections = parse_changelog("## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n- thing\n");
        // Installed is already at 1.0.0, and Unreleased is empty -> nothing.
        assert_eq!(sections_newer_than(&sections, "1.0.0"), None);
    }

    #[test]
    fn returns_none_for_unparseable_installed_version() {
        let sections = parse_changelog(SAMPLE);
        assert_eq!(sections_newer_than(&sections, "not-a-version"), None);
    }

    #[test]
    fn semver_parsing_and_compare() {
        assert_eq!(parse_semver("0.8.1"), Some((0, 8, 1)));
        assert_eq!(parse_semver("v1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_semver("0.8.0-rc1"), Some((0, 8, 0)));
        assert_eq!(parse_semver("0.8"), None);
        assert_eq!(parse_semver("2026.03.24.120000+abc"), None);
        assert!(semver_newer("0.9.0", "0.8.1"));
        assert!(semver_newer("0.8.2", "0.8.1"));
        assert!(!semver_newer("0.8.1", "0.8.1"));
        assert!(!semver_newer("0.8.0", "0.8.1"));
        assert!(!semver_newer("garbage", "0.8.1"));
    }
}
