// Every tab the agent works in lands in one "Sidekick" tab group, so the
// agent's tabs are visually separated from the user's own tabs (like other
// browser-agent extensions do). Best-effort by design: grouping is a
// convenience, so every failure is swallowed — it must never break a run.

const GROUP_TITLE = "Sidekick";
const GROUP_COLOR = "purple";

/**
 * Add the tab to the window's "Sidekick" group, creating the group if needed.
 * A tab that already sits in a group is left alone: the user's own groups are
 * theirs to organize, and tabs we grouped earlier are already where they
 * belong. Returns the group id, or null when the tab was not grouped.
 */
export async function ensureSidekickGroup(tabId) {
  if (tabId == null) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    // -1 (TAB_GROUP_ID_NONE) means "no group"; anything else is a real group.
    if (tab.groupId != null && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      return tab.groupId;
    }
    // Find the group by title in this window rather than remembering an id:
    // group ids die with the window/browser session, titles survive a query.
    const existing = await chrome.tabGroups.query({ windowId: tab.windowId, title: GROUP_TITLE });
    const groupId = existing.length
      ? await chrome.tabs.group({ tabIds: [tabId], groupId: existing[0].id })
      : await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR });
    return groupId;
  } catch {
    return null;
  }
}
