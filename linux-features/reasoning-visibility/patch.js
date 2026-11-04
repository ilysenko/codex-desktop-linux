"use strict";

const { settingsDescriptor } = require("./settings.js");
const { persistentDescriptor: persistent } = require("./persistent.js");
const { requestSummariesDescriptor: summaries } = require("./request-summaries.js");
const { standaloneDescriptor: standalone, applyStandalonePatch } = require("./standalone.js");
const { transcriptDescriptor: transcript, applyTranscriptPatch } = require("./transcript.js");

const { expandedDescriptor: expanded, reasoningComponent } = require("./expanded.js");

module.exports = {
  applyStandalonePatch,
  applyTranscriptPatch,
  reasoningComponent,
  descriptors: [standalone, persistent, transcript, summaries, expanded, settingsDescriptor],
};
