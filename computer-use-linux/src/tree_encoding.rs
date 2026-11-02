//! Wire encoding of accessibility trees in tool results and spill files.
//!
//! A Chromium window tree is mostly layout containers, and the full node
//! encoding spends most of its bytes on empty and default fields: `null`
//! values, empty action descriptions and keybindings, and a `text` block
//! holding nothing but the U+FFFC object replacement character that stands for
//! each child. The compact encoding leaves those out and lists actions by name.
//! `verbose=true` on get_app_state returns the full encoding, the same shape
//! [`AccessibilityNode`] serializes to.

use std::ops::{Deref, DerefMut};

use schemars::JsonSchema;
use serde::{Serialize, Serializer};

use crate::atspi_tree::{
    AccessibilityNode, AccessibilityTextSelection, AccessibilityValue, Bounds,
};

/// U+FFFC, the character AT-SPI text uses for each embedded child object.
pub(crate) const OBJECT_REPLACEMENT: char = '\u{fffc}';

/// How much of each node a result carries.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum NodeDetail {
    /// Empty and default fields left out; actions by name.
    #[default]
    Compact,
    /// Every field, with action descriptions and keybindings.
    Full,
}

impl NodeDetail {
    pub(crate) fn from_verbose(verbose: bool) -> Self {
        if verbose {
            Self::Full
        } else {
            Self::Compact
        }
    }
}

/// Text that carries only object replacement characters and whitespace: the
/// placeholder a container reports for its children, not readable copy.
pub(crate) fn is_placeholder_text(text: &str) -> bool {
    text.chars()
        .all(|ch| ch == OBJECT_REPLACEMENT || ch.is_whitespace())
}

/// One node in the compact encoding. Missing fields are null, empty, zero or
/// false; `actions` lists action names in AT-SPI index order.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub(crate) struct CompactNode {
    /// Pass as element_index to click, perform_action, set_value and scroll.
    pub index: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_index: Option<u32>,
    pub depth: u32,
    /// Pass as element_identifier to address this element directly.
    pub object_ref: String,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub child_count: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Bounds>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub states: Vec<String>,
    /// Action names; pass one as perform_action's action.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<AccessibilityValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<CompactText>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub supports_editable_text: bool,
}

/// AT-SPI text in the compact encoding. A caret is reported only for
/// editable text.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub(crate) struct CompactText {
    pub character_count: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caret_offset: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selections: Vec<AccessibilityTextSelection>,
}

fn is_zero(value: &i32) -> bool {
    *value == 0
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn non_empty(value: &Option<String>) -> Option<String> {
    value.as_ref().filter(|value| !value.is_empty()).cloned()
}

impl From<&AccessibilityNode> for CompactNode {
    fn from(node: &AccessibilityNode) -> Self {
        let editable = node.supports_editable_text;
        let text = node.text.as_ref().and_then(|text| {
            // A container's text is one U+FFFC per child, or nothing at all.
            // Content that could not be read still says text is there.
            let nothing_to_read = match text.content.as_deref() {
                Some(content) => is_placeholder_text(content),
                None => text.character_count == 0,
            };
            if !editable && nothing_to_read && text.selections.is_empty() {
                return None;
            }
            Some(CompactText {
                character_count: text.character_count,
                caret_offset: text.caret_offset.filter(|_| editable),
                content: non_empty(&text.content),
                truncated: text.truncated,
                selections: text.selections.clone(),
            })
        });
        Self {
            index: node.index,
            parent_index: node.parent_index,
            depth: node.depth,
            object_ref: node.object_ref.clone(),
            role: node.role.clone(),
            name: non_empty(&node.name),
            description: non_empty(&node.description),
            child_count: node.child_count,
            bounds: node.bounds.clone(),
            states: node.states.clone(),
            actions: node
                .actions
                .iter()
                .map(|action| action.name.clone())
                .collect(),
            value: node.value.clone(),
            text,
            supports_editable_text: editable,
        }
    }
}

/// A node as either encoding, for the output schema.
#[derive(JsonSchema)]
#[serde(untagged)]
#[allow(dead_code)]
pub(crate) enum WireNode {
    Compact(CompactNode),
    Full(AccessibilityNode),
}

/// Serialize one node in `detail`.
pub(crate) fn serialize_node<S: Serializer>(
    node: &AccessibilityNode,
    detail: NodeDetail,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match detail {
        NodeDetail::Compact => CompactNode::from(node).serialize(serializer),
        NodeDetail::Full => node.serialize(serializer),
    }
}

/// Serialized size of one node in `detail`.
pub(crate) fn node_json_len(node: &AccessibilityNode, detail: NodeDetail) -> usize {
    serde_json::to_string(&EncodedNode { node, detail }).map_or(usize::MAX, |json| json.len())
}

/// A node paired with its encoding.
pub(crate) struct EncodedNode<'a> {
    pub node: &'a AccessibilityNode,
    pub detail: NodeDetail,
}

impl Serialize for EncodedNode<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serialize_node(self.node, self.detail, serializer)
    }
}

/// Nodes paired with the encoding they serialize to.
pub(crate) struct EncodedNodes<'a> {
    pub nodes: &'a [AccessibilityNode],
    pub detail: NodeDetail,
}

impl Serialize for EncodedNodes<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.nodes.iter().map(|node| EncodedNode {
            node,
            detail: self.detail,
        }))
    }
}

/// A tree in a tool result: the nodes and the encoding they serialize to.
/// Derefs to the node list, so callers handle it as a `Vec`.
#[derive(Debug, Clone, Default)]
pub(crate) struct TreeNodes {
    pub nodes: Vec<AccessibilityNode>,
    pub detail: NodeDetail,
}

impl TreeNodes {
    pub(crate) fn new(nodes: Vec<AccessibilityNode>, detail: NodeDetail) -> Self {
        Self { nodes, detail }
    }
}

impl From<Vec<AccessibilityNode>> for TreeNodes {
    fn from(nodes: Vec<AccessibilityNode>) -> Self {
        Self::new(nodes, NodeDetail::Compact)
    }
}

impl Deref for TreeNodes {
    type Target = Vec<AccessibilityNode>;

    fn deref(&self) -> &Self::Target {
        &self.nodes
    }
}

impl DerefMut for TreeNodes {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.nodes
    }
}

impl Serialize for TreeNodes {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        EncodedNodes {
            nodes: &self.nodes,
            detail: self.detail,
        }
        .serialize(serializer)
    }
}

impl JsonSchema for TreeNodes {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "AccessibilityTree".into()
    }

    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        <Vec<WireNode>>::json_schema(generator)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atspi_tree::{AccessibilityAction, AccessibilityText};

    fn chromium_section() -> AccessibilityNode {
        AccessibilityNode {
            index: 4,
            parent_index: Some(3),
            depth: 5,
            object_ref: ":1.77/org/a11y/atspi/accessible/2147483651".to_string(),
            role: "section".to_string(),
            name: Some(String::new()),
            description: Some(String::new()),
            child_count: 2,
            bounds: Some(Bounds {
                x: 0,
                y: 80,
                width: 1200,
                height: 600,
            }),
            states: vec!["enabled".into(), "sensitive".into(), "showing".into()],
            actions: vec![AccessibilityAction {
                index: 0,
                name: "click".to_string(),
                description: String::new(),
                keybinding: String::new(),
            }],
            value: None,
            text: Some(AccessibilityText {
                character_count: 2,
                caret_offset: Some(0),
                content: Some("\u{fffc}\u{fffc}".to_string()),
                truncated: false,
                selections: Vec::new(),
            }),
            supports_editable_text: false,
        }
    }

    fn compact_json(node: &AccessibilityNode) -> serde_json::Value {
        serde_json::to_value(EncodedNode {
            node,
            detail: NodeDetail::Compact,
        })
        .unwrap()
    }

    #[test]
    fn compact_nodes_leave_out_empty_fields_and_placeholder_text() {
        let json = compact_json(&chromium_section());
        assert_eq!(
            json,
            serde_json::json!({
                "index": 4,
                "parent_index": 3,
                "depth": 5,
                "object_ref": ":1.77/org/a11y/atspi/accessible/2147483651",
                "role": "section",
                "child_count": 2,
                "bounds": {"x": 0, "y": 80, "width": 1200, "height": 600},
                "states": ["enabled", "sensitive", "showing"],
                "actions": ["click"],
            })
        );
    }

    #[test]
    fn compact_nodes_leave_out_empty_text_but_keep_unread_text() {
        let mut node = chromium_section();
        node.text = Some(AccessibilityText {
            character_count: 0,
            caret_offset: Some(0),
            content: None,
            truncated: false,
            selections: Vec::new(),
        });
        assert!(compact_json(&node).get("text").is_none());

        // A failed read leaves content out but the count says text is there.
        node.text.as_mut().unwrap().character_count = 12;
        assert_eq!(
            compact_json(&node)["text"],
            serde_json::json!({"character_count": 12})
        );
    }

    #[test]
    fn compact_editable_text_keeps_its_content_and_caret() {
        let mut node = chromium_section();
        node.role = "entry".to_string();
        node.supports_editable_text = true;
        node.text = Some(AccessibilityText {
            character_count: 5,
            caret_offset: Some(5),
            content: Some("hello".to_string()),
            truncated: false,
            selections: Vec::new(),
        });
        let json = compact_json(&node);
        assert_eq!(
            json["text"],
            serde_json::json!({"character_count": 5, "caret_offset": 5, "content": "hello"})
        );
        assert_eq!(json["supports_editable_text"], true);

        // An empty editable field still says it holds text, with its caret.
        node.text = Some(AccessibilityText {
            character_count: 0,
            caret_offset: Some(0),
            content: Some(String::new()),
            truncated: false,
            selections: Vec::new(),
        });
        assert_eq!(
            compact_json(&node)["text"],
            serde_json::json!({"character_count": 0, "caret_offset": 0})
        );
    }

    #[test]
    fn static_text_keeps_its_content_without_a_caret() {
        let mut node = chromium_section();
        node.role = "static".to_string();
        node.text = Some(AccessibilityText {
            character_count: 9,
            caret_offset: Some(0),
            content: Some("Saved \u{fffc}ok".to_string()),
            truncated: false,
            selections: Vec::new(),
        });
        assert_eq!(
            compact_json(&node)["text"],
            serde_json::json!({"character_count": 9, "content": "Saved \u{fffc}ok"})
        );
    }

    #[test]
    fn full_detail_is_the_node_serialization() {
        let node = chromium_section();
        let full = serde_json::to_value(EncodedNode {
            node: &node,
            detail: NodeDetail::Full,
        })
        .unwrap();
        assert_eq!(full, serde_json::to_value(&node).unwrap());
    }
}
