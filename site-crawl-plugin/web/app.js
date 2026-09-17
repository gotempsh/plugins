// SPDX-FileCopyrightText: 2024-2026 Temps Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0
const $ = (id) => document.getElementById(id);
const base = location.pathname.includes("/ui")
  ? location.pathname.split("/ui")[0]
  : "";
let selected = null,
  filter = "all",
  current = null,
  timer = null;
const node = (tag, text, className) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
};
function showError(error) {
  $("error").hidden = !error;
  $("error").textContent = error?.message ?? "";
}
async function api(path, options) {
  const response = await fetch(`${base}/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json" },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed.");
  return body;
}
function button(label, action, className) {
  const el = node("button", label, className);
  el.type = "button";
  el.onclick = () => Promise.resolve(action()).catch(showError);
  return el;
}
async function refresh() {
  const reports = await api("/reports");
  $("history").replaceChildren();
  $("start").disabled = reports.some((report) => report.state === "running");
  if (!reports.length)
    $("history").append(
      node("p", "Your first report will appear here.", "hint"),
    );
  for (const report of reports) {
    const item = button(
      "",
      () => select(report.id),
      `history-item${selected === report.id ? " active" : ""}`,
    );
    item.append(
      node("strong", new URL(report.url).hostname),
      node(
        "small",
        `${report.state} · ${report.checked} URLs · ${new Date(report.startedAt).toLocaleDateString()}`,
      ),
    );
    $("history").append(item);
  }
  if (!selected && reports.length) await select(reports[0].id);
}
async function select(id) {
  selected = id;
  current = await api(`/reports/${id}`);
  render();
  await refresh();
  schedule();
}
function schedule() {
  clearTimeout(timer);
  if (current?.state === "running")
    timer = setTimeout(() => select(selected).catch(showError), 1500);
}
function render() {
  const report = current;
  if (!report) return;
  const container = $("report");
  container.replaceChildren();
  const heading = node("div", undefined, "report-heading"),
    title = node("div");
  title.append(
    node("h2", report.url),
    node(
      "p",
      `${report.state.toUpperCase()} · ${new Date(report.startedAt).toLocaleString()}`,
      "report-state",
    ),
  );
  const actions = node("div", undefined, "actions");
  const download = node("a", "Export JSON");
  download.href = `${base}/api/reports/${report.id}/export`;
  download.download = "";
  actions.append(download);
  if (report.state === "running")
    actions.append(
      button("Cancel", async () => {
        await api(`/reports/${report.id}/cancel`, { method: "POST" });
        await select(report.id);
      }),
    );
  else
    actions.append(
      button("Delete", async () => {
        if (!confirm("Delete this saved crawl report?")) return;
        await api(`/reports/${report.id}`, { method: "DELETE" });
        selected = null;
        current = null;
        container.replaceChildren(
          node(
            "p",
            "Report deleted. Start a crawl or select another report.",
            "hint",
          ),
        );
        await refresh();
      }),
    );
  heading.append(title, actions);
  container.append(heading);
  const stats = node("div", undefined, "stats");
  for (const [value, label] of [
    [report.pages.length, "URLs checked"],
    [
      report.pages.filter((p) => p.issues.some((i) => i.severity === "error"))
        .length,
      "Routes with errors",
    ],
    [
      report.pages.reduce(
        (sum, p) =>
          sum + p.issues.filter((i) => i.severity === "warning").length,
        0,
      ),
      "SEO warnings",
    ],
  ]) {
    const stat = node("div", undefined, "stat");
    stat.append(node("strong", String(value)), node("span", label));
    stats.append(stat);
  }
  container.append(stats);
  if (report.trigger)
    container.append(
      node(
        "p",
        `Deployment #${report.trigger.deploymentId} · ${report.trigger.environmentName} · automatic crawl`,
        "notice",
      ),
    );
  if (report.error) container.append(node("p", report.error, "notice"));
  for (const text of report.notices)
    container.append(node("p", text, "notice"));
  if (report.state === "running")
    container.append(
      node(
        "p",
        `Crawling… ${report.discovered} URLs discovered. You can leave this page; the crawl continues.`,
        "notice",
      ),
    );
  const filters = node("div", undefined, "filters");
  for (const [value, label] of [
    ["all", "All URLs"],
    ["error", "Broken routes"],
    ["warning", "SEO warnings"],
  ]) {
    const el = button(label, () => {
      filter = value;
      render();
    });
    el.setAttribute("aria-pressed", String(filter === value));
    filters.append(el);
  }
  container.append(filters);
  const pages = report.pages.filter(
    (page) =>
      filter === "all" ||
      page.issues.some((issue) => issue.severity === filter),
  );
  if (!pages.length)
    container.append(
      node(
        "p",
        report.state === "running"
          ? "Waiting for matching results…"
          : "No matching URLs in this report.",
        "hint",
      ),
    );
  for (const page of pages) {
    const details = node("details", undefined, "page"),
      summary = node("summary");
    const severity = page.issues.some((i) => i.severity === "error")
      ? "error"
      : page.issues.some((i) => i.severity === "warning")
        ? "warning"
        : "";
    summary.append(
      node(
        "span",
        page.status === null ? "—" : String(page.status),
        `badge ${severity}`,
      ),
      node("span", page.url, "page-url"),
      node("span", String(page.issues.length), "badge"),
    );
    details.append(summary);
    const contents = node("div", undefined, "details");
    if (page.title) contents.append(node("p", page.title, "hint"));
    if (page.finalUrl !== page.url)
      contents.append(node("p", `Final URL: ${page.finalUrl}`, "hint"));
    if (!page.issues.length)
      contents.append(node("p", "No issues found by these checks.", "hint"));
    for (const item of page.issues) {
      const el = node("div", undefined, "issue");
      el.append(
        node("strong", `${item.severity.toUpperCase()} · ${item.message}`),
        node("p", item.fix),
      );
      contents.append(el);
    }
    const sources = node("div", undefined, "sources");
    sources.append(node("h3", "Discovered from"));
    for (const source of page.sources) sources.append(node("div", source));
    contents.append(sources);
    details.append(contents);
    container.append(details);
  }
}
$("crawl-form").onsubmit = async (event) => {
  event.preventDefault();
  showError(null);
  $("start").disabled = true;
  try {
    const { id } = await api("/reports", {
      method: "POST",
      body: JSON.stringify({
        url: $("url").value,
        maxPages: Number($("limit").value),
      }),
    });
    await select(id);
  } catch (error) {
    showError(error);
    $("start").disabled = false;
  }
};
$("refresh").onclick = () =>
  (selected ? select(selected) : refresh()).catch(showError);
let automationState = null;
let automationDirty = false;
$("automation-form").oninput = () => {
  automationDirty = true;
};
async function loadAutomation(force = false) {
  const state = await api("/automation");
  automationState = state;
  $("automation-status").textContent = state.access.configured
    ? state.settings.enabled
      ? "Listening for successful deployments."
      : "Automatic crawling is paused."
    : state.access.reason;
  if (state.notice) $("automation-status").textContent += ` ${state.notice}`;
  $("automation-setup").hidden = state.access.configured;
  $("queue-state").textContent = `${state.queued} queued`;
  $("clear-queue").hidden = state.queued === 0;
  if (automationDirty && !force) return;
  $("auto-enabled").checked = state.settings.enabled;
  $("auto-production").checked = state.settings.productionOnly;
  $("auto-limit").value = state.settings.maxPages;
  $("auto-projects").replaceChildren();
  if (!state.projects.length)
    $("auto-projects").append(
      node(
        "p",
        "Project controls appear as deployment events arrive. All projects are included by default.",
        "hint",
      ),
    );
  for (const project of state.projects) {
    const label = node("label", undefined, "check-label");
    const check = node("input");
    check.type = "checkbox";
    check.checked = !state.settings.excludedProjects.includes(project.id);
    check.dataset.projectId = String(project.id);
    check.onchange = () => {
      automationDirty = true;
    };
    label.append(check, node("span", new URL(project.url).hostname));
    $("auto-projects").append(label);
  }
  automationDirty = false;
}
$("automation-form").onsubmit = async (event) => {
  event.preventDefault();
  showError(null);
  try {
    const excluded = new Set(automationState?.settings.excludedProjects ?? []);
    for (const check of document.querySelectorAll("[data-project-id]")) {
      const id = Number(check.dataset.projectId);
      if (check.checked) excluded.delete(id);
      else excluded.add(id);
    }
    await api("/automation", {
      method: "PUT",
      body: JSON.stringify({
        enabled: $("auto-enabled").checked,
        productionOnly: $("auto-production").checked,
        maxPages: Number($("auto-limit").value),
        excludedProjects: [...excluded],
      }),
    });
    await loadAutomation(true);
  } catch (error) {
    showError(error);
  }
};
$("clear-queue").onclick = async () => {
  try {
    await api("/automation/queue", { method: "DELETE" });
    await loadAutomation();
  } catch (error) {
    showError(error);
  }
};
Promise.all([refresh(), loadAutomation()]).catch(showError);
setInterval(() => {
  if (!document.hidden) {
    loadAutomation().catch(showError);
    refresh().catch(showError);
  }
}, 15000);
