/**
 * Deliberately legacy-style server-rendered markup: nested tables, no CSS
 * classes/ids used as hooks, no data-testid attributes anywhere. Controls
 * are still real semantic HTML (button/a/input/label) so the accessibility
 * tree exposes usable roles + accessible names, matching how most legacy
 * enterprise apps actually render even when they look dated.
 *
 * The chrome below (header/tabs/nav/panel/footer) is purely cosmetic: every
 * <label>/<button>/<a> text the capability artifacts target is left
 * byte-identical, and "ALL-CAPS field labels" is done with CSS
 * text-transform rather than literal uppercase text, so the DOM text (and
 * therefore the accessible name Playwright's getByRole(..., {exact:true})
 * matches on) never changes. Verified empirically against this Playwright
 * version: text-transform does not alter ariaSnapshotJSON()'s computed name.
 */
import type { Member } from "./data.js";

const chrome = `
<style>
  body { margin:0; padding:0; background:#c0c0c0; font-family: Tahoma, "MS Sans Serif", Arial, sans-serif; font-size:11px; color:#000000; }
  table.mfs-shell { border-collapse:collapse; }
  .mfs-header-inner td { background:#003366; color:#ffffff; padding:5px 8px; }
  .mfs-wordmark { font-family: Arial, sans-serif; font-size:16px; font-weight:bold; letter-spacing:1px; color:#ffcc33; }
  .mfs-subwordmark { font-size:10px; color:#a9c2dc; letter-spacing:2px; }
  .mfs-opinfo { font-size:10px; color:#d8e4f0; text-align:right; white-space:nowrap; }
  .mfs-tabs-inner td { padding:0; }
  .mfs-tab { padding:4px 14px; font-weight:bold; font-size:11px; border:1px solid #6e6e6e; border-bottom:none; }
  .mfs-tab-active { background:#f0f0f0; color:#003366; border-top:2px solid #ffcc33; }
  .mfs-tab-inactive { background:#003366; }
  .mfs-tab-inactive a { color:#ffffff; }
  .mfs-tab a, .mfs-tab-active { text-decoration:none; }
  .mfs-tab-active a { color:#003366; text-decoration:none; }
  .mfs-tabstrip-fill { border-bottom:2px solid #6e6e6e; }
  .mfs-body-row td { vertical-align:top; }
  .mfs-nav { background:#e4e4e4; border-right:2px groove #ffffff; width:150px; padding:0; }
  .mfs-nav-heading { background:#d4d0c8; color:#003366; font-weight:bold; font-size:10px; text-transform:uppercase; letter-spacing:1px; padding:4px 6px; border-bottom:1px solid #a0a0a0; }
  .mfs-nav a { display:block; color:#003366; text-decoration:none; padding:4px 8px; font-size:11px; border-bottom:1px solid #cfcfcf; }
  .mfs-nav a:hover { background:#c9dcef; }
  .mfs-content-outer { background:#c0c0c0; padding:6px; }
  .mfs-panel { background:#f0f0f0; border-style:ridge; border-width:2px; border-color:#f0f0f0 #808080 #808080 #f0f0f0; padding:10px; }
  .mfs-panel h2 { font-family: Tahoma, Arial, sans-serif; font-size:13px; color:#003366; border-bottom:1px solid #003366; padding-bottom:4px; margin:0 0 8px 0; }
  .mfs-crumb { font-size:10px; color:#555555; margin-bottom:6px; }
  .mfs-footer-inner td { background:#003366; color:#c9d8e6; font-size:10px; padding:3px 8px; }
  .mfs-field-label { text-transform:uppercase; font-weight:bold; font-size:10px; color:#222222; letter-spacing:0.5px; }
  table.mfs-form { border-style:groove; border-width:1px; border-color:#a0a0a0; background:#e8e8e8; }
  table.mfs-form td { padding:4px 6px; }
  table.mfs-data { border-collapse:collapse; border-style:ridge; border-width:2px; border-color:#f0f0f0 #808080 #808080 #f0f0f0; }
  table.mfs-data td, table.mfs-data th { border:1px solid #a0a0a0; padding:3px 8px; font-size:11px; }
  table.mfs-data th { background:#003366; color:#ffffff; text-transform:uppercase; font-size:10px; letter-spacing:0.5px; }
  table.mfs-data tr.mfs-row-even td { background:#f7f7f7; }
  table.mfs-data tr.mfs-row-odd td { background:#ffffff; }
  .mfs-input, .mfs-select { font-family: Tahoma, Arial, sans-serif; font-size:11px; border-style:inset; border-width:2px; border-color:#808080 #f0f0f0 #f0f0f0 #808080; padding:2px 3px; background:#ffffff; }
  .mfs-btn { font-family: Tahoma, Arial, sans-serif; font-size:11px; font-weight:bold; color:#000000; border-style:outset; border-width:2px; border-color:#f0f0f0 #808080 #808080 #f0f0f0; background:#d4d0c8; padding:3px 12px; }
  .mfs-btn:active { border-style:inset; }
</style>`;

const TABS = ["Accounts", "Members", "Transactions", "Reports", "Admin"] as const;

function tabStrip(activeTab: string): string {
  const cells = TABS.map(
    (t) =>
      `<td class="mfs-tab ${t === activeTab ? "mfs-tab-active" : "mfs-tab-inactive"}"><a href="#">${t}</a></td>`
  ).join("\n            ");
  return `<table class="mfs-tabs-inner" cellpadding="0" cellspacing="0" border="0"><tr>
            ${cells}
            <td class="mfs-tabstrip-fill" width="100%">&nbsp;</td>
          </tr></table>`;
}

const shell = (title: string, body: string, activeTab: string = "Accounts") => `<!DOCTYPE html>
<html>
<head><title>${title} - Meridian Core Banking</title>${chrome}</head>
<body>
<table class="mfs-shell" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td>
      <table class="mfs-header-inner" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td>
          <span class="mfs-wordmark">MERIDIAN FINANCIAL SYSTEMS</span><br>
          <span class="mfs-subwordmark">CORE BANKING &mdash; TELLER CONSOLE</span>
        </td>
        <td class="mfs-opinfo">Operator: demo-teller&nbsp;|&nbsp;Branch 0412&nbsp;|&nbsp;Session 00:14:22</td>
      </tr></table>
    </td>
  </tr>
  <tr>
    <td>${tabStrip(activeTab)}</td>
  </tr>
  <tr class="mfs-body-row">
    <td>
      <!--
        Nav and content are two INDEPENDENT floated tables, not two <td>s of one
        shared <tr>. A shared 2-column row here would itself be an ancestor of
        every page's body content and would satisfy structural extraction
        locators like 'tr:has-text("Checking Balance") td:nth-of-type(2)' at
        this shallow level (its own 2nd <td> = the whole content panel),
        winning over the real, deeper match since Playwright's :has-text +
        .first() prefers ancestors over descendants in document order. Keeping
        every <tr> between here and the body content down to exactly one direct
        <td> forces resolution to keep descending until it hits the real row.
      -->
      <table class="mfs-nav-table" cellpadding="0" cellspacing="0" border="0"><tr><td class="mfs-nav">
        <div class="mfs-nav-heading">Modules</div>
        <a href="/search">Member Search</a>
        <a href="#">Account Maintenance</a>
        <a href="#">Transaction History</a>
        <a href="#">Deposit Holds</a>
        <a href="#">Branch Reports</a>
        <a href="#">End-of-Day Reconciliation</a>
        <a href="#">System Admin</a>
      </td></tr></table>
      <table class="mfs-content-table" cellpadding="0" cellspacing="0" border="0"><tr><td class="mfs-content-outer">
        <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="mfs-panel">
${body}
        </td></tr></table>
      </td></tr></table>
      <br clear="all">
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <table class="mfs-footer-inner" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td>Connected: MERIDIAN-CORE-DB01 (PROD-REPLICA-02)</td>
        <td align="right">&copy; Meridian Financial Systems &mdash; Internal Use Only &mdash; Rev. 4.2.1</td>
      </tr></table>
    </td>
  </tr>
</table>
</body>
</html>`;

export function loginPage(error?: string): string {
  return shell(
    "Login",
    `
<h2>Operator Login</h2>
${error ? `<p><font color="red">${error}</font></p>` : ""}
<form method="post" action="/login">
  <table class="mfs-form" cellpadding="3">
    <tr><td class="mfs-field-label"><label for="username">Username</label></td><td><input class="mfs-input" type="text" id="username" name="username"></td></tr>
    <tr><td class="mfs-field-label"><label for="password">Password</label></td><td><input class="mfs-input" type="password" id="password" name="password"></td></tr>
    <tr><td colspan="2"><button class="mfs-btn" type="submit">Log In</button></td></tr>
  </table>
</form>`
  );
}

export function searchPage(query?: string, results?: Member[]): string {
  const resultsTable =
    results !== undefined
      ? results.length > 0
        ? `<table class="mfs-data" border="1" cellpadding="4">
            <tr><th>Member ID</th><th>Name</th><th>&nbsp;</th></tr>
            ${results
              .map(
                (m, i) =>
                  `<tr class="${i % 2 === 0 ? "mfs-row-odd" : "mfs-row-even"}"><td>${m.id}</td><td>${m.name}</td><td><a href="/member/${m.id}">View</a></td></tr>`
              )
              .join("\n")}
           </table>`
        : `<p id="no-results">No member found matching "${query}".</p>`
      : "";
  return shell(
    "Member Search",
    `
<h2>Member Search</h2>
<div class="mfs-crumb">Members &raquo; Search</div>
<form method="get" action="/search">
  <table class="mfs-form" cellpadding="3">
    <tr><td class="mfs-field-label"><label for="q">Member ID or name</label></td>
        <td><input class="mfs-input" type="text" id="q" name="q" value="${query ?? ""}"></td>
        <td><button class="mfs-btn" type="submit">Search</button></td></tr>
  </table>
</form>
<br>
${resultsTable}`,
    "Members"
  );
}

export function memberDetailPage(member: Member): string {
  return shell(
    "Member Detail",
    `
<h2>Member Detail</h2>
<div class="mfs-crumb">Members &raquo; Search &raquo; ${member.id}</div>
<table class="mfs-data" border="1" cellpadding="4">
  <tr class="mfs-row-odd"><td>Member ID</td><td>${member.id}</td></tr>
  <tr class="mfs-row-even"><td>Name</td><td>${member.name}</td></tr>
  <tr class="mfs-row-odd"><td>Checking Balance</td><td><span>$${member.checking.toFixed(2)}</span></td></tr>
  <tr class="mfs-row-even"><td>Savings Balance</td><td><span>$${member.savings.toFixed(2)}</span></td></tr>
</table>
<p><a href="/member/${member.id}/open-subaccount">Open Sub-Account</a></p>
<p><a href="/search">Back to Search</a></p>`,
    "Members"
  );
}

export function memberNotFoundPage(query: string): string {
  return shell(
    "Not Found",
    `<h2>Member Detail</h2><p id="no-results">No member found for "${query}".</p><p><a href="/search">Back to Search</a></p>`,
    "Members"
  );
}

export function supervisorRequiredPage(member: Member): string {
  return shell(
    "Supervisor Approval Required",
    `
<h2>Supervisor Approval Required</h2>
<p>Member ${member.id} (${member.name}) is flagged for manager review.
A supervisor must approve before a sub-account can be opened for this member.</p>
<form method="post" action="/member/${member.id}/open-subaccount/override">
  <button class="mfs-btn" type="submit">Override (Supervisor)</button>
</form>
<p><a href="/member/${member.id}">Back to Member Detail</a></p>`,
    "Accounts"
  );
}

export function openSubAccountForm(member: Member, error?: string, prev?: { type?: string; deposit?: string; nickname?: string }): string {
  return shell(
    "Open Sub-Account",
    `
<h2>Open Sub-Account for ${member.name} (${member.id})</h2>
<div class="mfs-crumb">Accounts &raquo; Members &raquo; ${member.id} &raquo; Open Sub-Account</div>
${error ? `<p><font color="red" id="validation-error">${error}</font></p>` : ""}
<form method="post" action="/member/${member.id}/open-subaccount">
  <table class="mfs-form" cellpadding="3">
    <tr><td class="mfs-field-label"><label for="type">Account Type</label></td>
        <td><select class="mfs-select" id="type" name="type">
              <option value="standard-savings" ${prev?.type === "standard-savings" ? "selected" : ""}>Standard Savings</option>
              <option value="youth-savings" ${prev?.type === "youth-savings" ? "selected" : ""}>Youth Savings</option>
            </select></td></tr>
    <tr><td class="mfs-field-label"><label for="deposit">Initial Deposit (USD)</label></td>
        <td><input class="mfs-input" type="text" id="deposit" name="deposit" value="${prev?.deposit ?? ""}"></td></tr>
    <tr><td class="mfs-field-label"><label for="nickname">Account Nickname</label></td>
        <td><input class="mfs-input" type="text" id="nickname" name="nickname" value="${prev?.nickname ?? ""}"></td></tr>
    <tr><td colspan="2"><button class="mfs-btn" type="submit">Continue</button></td></tr>
  </table>
</form>
<p><a href="/member/${member.id}">Back to Member Detail</a></p>`,
    "Accounts"
  );
}

export function confirmationPage(member: Member, sub: { type: string; deposit: string; nickname: string }): string {
  return shell(
    "Confirm New Sub-Account",
    `
<h2>Confirm New Sub-Account</h2>
<table class="mfs-data" border="1" cellpadding="4">
  <tr class="mfs-row-odd"><td>Member</td><td>${member.name} (${member.id})</td></tr>
  <tr class="mfs-row-even"><td>Account Type</td><td>${sub.type}</td></tr>
  <tr class="mfs-row-odd"><td>Initial Deposit</td><td>$${sub.deposit}</td></tr>
  <tr class="mfs-row-even"><td>Nickname</td><td>${sub.nickname}</td></tr>
</table>
<form method="post" action="/member/${member.id}/confirm">
  <input type="hidden" name="type" value="${sub.type}">
  <input type="hidden" name="deposit" value="${sub.deposit}">
  <input type="hidden" name="nickname" value="${sub.nickname}">
  <button class="mfs-btn" type="submit">Confirm &amp; Open Account</button>
</form>
<p><a href="/member/${member.id}">Cancel</a></p>`,
    "Accounts"
  );
}

export function accountOpenedPage(member: Member): string {
  return shell(
    "Account Opened",
    `<h2 id="success-heading">Sub-Account Opened</h2><p>A new sub-account was opened for ${member.name} (${member.id}).</p><p><a href="/search">Back to Search</a></p>`,
    "Accounts"
  );
}

/**
 * Error-injection pages (see app.ts's ?inject= middleware). These stand in for two real runtime
 * conditions a legacy app throws at a replay: an unexpected interstitial that must be dismissed,
 * and a transient slow load that clears on its own. `target` is the path the user actually
 * wanted, so recovering (dismissing, or waiting out the delay) lands back on the intended page.
 */
export function sessionNoticePage(target: string): string {
  return shell(
    "Session Notice",
    `
<h2>Session Notice</h2>
<p>Your session encountered a temporary notice. Please dismiss this notice to continue.</p>
<form method="get" action="${target}">
  <button class="mfs-btn" type="submit">Dismiss</button>
</form>`
  );
}

export function slowLoadPage(target: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Please wait - Meridian Core Banking</title>
  <meta http-equiv="refresh" content="4;url=${target}">
</head>
<body bgcolor="#ffffff">
<h2>Please wait</h2>
<p>Your request is taking longer than usual to process. This page will continue automatically.</p>
</body>
</html>`;
}
