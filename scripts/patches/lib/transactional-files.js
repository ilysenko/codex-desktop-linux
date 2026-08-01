"use strict";

const fs = require("node:fs");

const {
  PatchIntegrityError,
} = require("../integrity-error.js");

const bufferEquals = Function.call.bind(Buffer.prototype.equals);

function readTrustedBytes(readFileSync, filePath) {
  const bytes = readFileSync(filePath);
  return Buffer.isBuffer(bytes) ? Buffer.from(bytes) : null;
}

function writeUtf8FileCandidatesTransactionally(candidates, options = {}) {
  const writeFileSync = options.writeFileSync ?? fs.writeFileSync;
  const readFileSync = options.readFileSync ?? fs.readFileSync;
  const description = options.description ?? "Patch file transaction";
  const prepared = candidates.map((candidate) => {
    const sourceBytes = Buffer.from(candidate.source, "utf8");
    const patchedBytes = Buffer.from(candidate.patchedSource, "utf8");
    const currentBytes = readTrustedBytes(readFileSync, candidate.filePath);
    if (currentBytes == null || !bufferEquals(sourceBytes, currentBytes)) {
      throw new Error(`source byte verification failed for ${candidate.filePath}`);
    }
    return { ...candidate, sourceBytes, patchedBytes };
  });
  const pending = prepared.filter(({ sourceBytes, patchedBytes }) =>
    !patchedBytes.equals(sourceBytes)
  );
  const attempted = [];

  try {
    for (const candidate of pending) {
      const currentBytes = readTrustedBytes(readFileSync, candidate.filePath);
      if (currentBytes == null || !bufferEquals(candidate.sourceBytes, currentBytes)) {
        throw new Error(`source byte verification failed for ${candidate.filePath}`);
      }
      attempted.push(candidate);
      writeFileSync(candidate.filePath, Buffer.from(candidate.patchedBytes));
      const writtenBytes = readTrustedBytes(readFileSync, candidate.filePath);
      if (writtenBytes == null || !bufferEquals(candidate.patchedBytes, writtenBytes)) {
        throw new Error(`write byte verification failed for ${candidate.filePath}`);
      }
    }
  } catch (error) {
    const rollbackWriteFailures = [];
    for (const candidate of [...attempted].reverse()) {
      try {
        writeFileSync(candidate.filePath, Buffer.from(candidate.sourceBytes));
      } catch (rollbackError) {
        rollbackWriteFailures.push(rollbackError);
      }
    }

    const rollbackVerificationFailures = [];
    for (const candidate of prepared) {
      try {
        const restoredBytes = readTrustedBytes(readFileSync, candidate.filePath);
        if (restoredBytes == null || !bufferEquals(candidate.sourceBytes, restoredBytes)) {
          rollbackVerificationFailures.push(
            new Error(`rollback byte verification failed for ${candidate.filePath}`),
          );
        }
      } catch (verificationError) {
        rollbackVerificationFailures.push(
          new Error(
            `rollback byte verification failed for ${candidate.filePath}: ` +
              `${verificationError instanceof Error ? verificationError.message : String(verificationError)}`,
          ),
        );
      }
    }

    if (rollbackVerificationFailures.length > 0) {
      const writeFailureContext = rollbackWriteFailures[0] == null
        ? ""
        : `; rollback write also failed: ${rollbackWriteFailures[0].message}`;
      throw new PatchIntegrityError(
        `${description} rollback could not restore original bytes: ` +
          `${rollbackVerificationFailures[0].message}${writeFailureContext}`,
      );
    }

    throw error;
  }

  return pending.length;
}

module.exports = {
  writeUtf8FileCandidatesTransactionally,
};
