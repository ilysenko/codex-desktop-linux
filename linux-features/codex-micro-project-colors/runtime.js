'use strict';

const defaults = Object.freeze({});

function projectKey(project) {
  const {projectId, projectKind = 'local', hostId = 'local'} = project ?? {};
  if (typeof projectId !== 'string' || !projectId ||
      !['local', 'remote'].includes(projectKind) || typeof hostId !== 'string' || !hostId) return null;
  return JSON.stringify([projectKind, hostId, projectId]);
}

function normalizeColors(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, color]) => {
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return false;
    try {
      const parts = JSON.parse(key);
      return Array.isArray(parts) && parts.length === 3 &&
        projectKey({projectKind:parts[0],hostId:parts[1],projectId:parts[2]}) === key;
    } catch { return false; }
  }).map(([key, color]) => [key, color.toLowerCase()]));
}

function setColor(value, key, color) {
  const colors = normalizeColors(value);
  if (color == null) delete colors[key];
  else colors[key] = color;
  return normalizeColors(colors);
}

function colorSlots(slots, groups, value) {
  const colors = normalizeColors(value), byThread = new Map();
  for (const group of groups) {
    const color = colors[projectKey(group)];
    if (color == null) continue;
    for (const key of group.threadKeys) byThread.set(key, color);
  }
  return slots.map(slot => {
    const color = byThread.get(slot.threadKey);
    if (slot.status !== 'working' || color == null) return slot;
    return {...slot, colorOverride:parseInt(color.slice(1), 16)};
  });
}

function slotColor(slot, fallback) {
  const color = slot?.colorOverride;
  return slot?.status === 'working' && Number.isInteger(color) && color >= 0 && color <= 0xffffff
    ? color : fallback;
}

module.exports = {defaults,projectKey,normalizeColors,setColor,colorSlots,slotColor};
