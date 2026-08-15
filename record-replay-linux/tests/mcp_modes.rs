use codex_record_replay_linux::mcp::{tool_names, McpMode};

#[test]
fn skysight_mode_exposes_only_activity_memory_tools() {
    let names = tool_names(McpMode::Skysight);

    assert_eq!(
        names,
        [
            "doctor",
            "skysight_list_exclusions",
            "skysight_pause",
            "skysight_resume",
            "skysight_snapshot",
            "skysight_start",
            "skysight_status",
            "skysight_stop",
            "skysight_update_exclusion",
        ]
    );
}

#[test]
fn event_stream_mode_retains_recording_and_activity_memory_tools() {
    let names = tool_names(McpMode::EventStream);

    assert!(names.contains(&"event_stream_start".to_string()));
    assert!(names.contains(&"draft_skill_prompt".to_string()));
    assert!(names.contains(&"skysight_start".to_string()));
}
