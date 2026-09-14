/**
 * Deliberately legacy-style server-rendered markup: nested tables, no CSS
 * classes/ids used as hooks, no data-testid attributes anywhere. Controls
 * are still real semantic HTML (button/a/input/label) so the accessibility
 * tree exposes usable roles + accessible names, matching how most legacy
 * enterprise apps actually render even when they look dated.
 */
import type { Member } from "./data.js";

const shell = (title: string, body: string) => `<!DOCTYPE html>
<html>
<head><title>${title} - Meridian Core Banking</title></head>
<body bgcolor="#ffffff">
<table width="100%" cellpadding="4" cellspacing="0" border="0">
  <tr bgcolor="#003366">
    <td><font color="white" size="4"><b>Meridian Core Banking &mdash; Teller Console</b></font></td>
  </tr>
</table>
<hr>
${body}
</body>
</html>`;

export function loginPage(error?: string): string {
  return shell(
    "Login",
    `
<h2>Operator Login</h2>
${error ? `<p><font color="red">${error}</font></p>` : ""}
<form method="post" action="/login">
  <table cellpadding="3">
    <tr><td><label for="username">Username</label></td><td><input type="text" id="username" name="username"></td></tr>
    <tr><td><label for="password">Password</label></td><td><input type="password" id="password" name="password"></td></tr>
    <tr><td colspan="2"><button type="submit">Log In</button></td></tr>
  </table>
</form>`
  );
}

export function searchPage(query?: string, results?: Member[]): string {
  const resultsTable =
    results !== undefined
      ? results.length > 0
        ? `<table border="1" cellpadding="4">
            <tr><td><b>Member ID</b></td><td><b>Name</b></td><td></td></tr>
            ${results
              .map(
                (m) =>
                  `<tr><td>${m.id}</td><td>${m.name}</td><td><a href="/member/${m.id}">View</a></td></tr>`
              )
              .join("\n")}
           </table>`
        : `<p id="no-results">No member found matching "${query}".</p>`
      : "";
  return shell(
    "Member Search",
    `
<h2>Member Search</h2>
<form method="get" action="/search">
  <table cellpadding="3">
    <tr><td><label for="q">Member ID or name</label></td>
        <td><input type="text" id="q" name="q" value="${query ?? ""}"></td>
        <td><button type="submit">Search</button></td></tr>
  </table>
</form>
${resultsTable}`
  );
}

export function memberDetailPage(member: Member): string {
  return shell(
    "Member Detail",
    `
<h2>Member Detail</h2>
<table border="1" cellpadding="4">
  <tr><td>Member ID</td><td>${member.id}</td></tr>
  <tr><td>Name</td><td>${member.name}</td></tr>
  <tr><td>Checking Balance</td><td><span>$${member.checking.toFixed(2)}</span></td></tr>
  <tr><td>Savings Balance</td><td><span>$${member.savings.toFixed(2)}</span></td></tr>
</table>
<p><a href="/member/${member.id}/open-subaccount">Open Sub-Account</a></p>
<p><a href="/search">Back to Search</a></p>`
  );
}

export function memberNotFoundPage(query: string): string {
  return shell(
    "Not Found",
    `<h2>Member Detail</h2><p id="no-results">No member found for "${query}".</p><p><a href="/search">Back to Search</a></p>`
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
  <button type="submit">Override (Supervisor)</button>
</form>
<p><a href="/member/${member.id}">Back to Member Detail</a></p>`
  );
}

export function openSubAccountForm(member: Member, error?: string, prev?: { type?: string; deposit?: string; nickname?: string }): string {
  return shell(
    "Open Sub-Account",
    `
<h2>Open Sub-Account for ${member.name} (${member.id})</h2>
${error ? `<p><font color="red" id="validation-error">${error}</font></p>` : ""}
<form method="post" action="/member/${member.id}/open-subaccount">
  <table cellpadding="3">
    <tr><td><label for="type">Account Type</label></td>
        <td><select id="type" name="type">
              <option value="standard-savings" ${prev?.type === "standard-savings" ? "selected" : ""}>Standard Savings</option>
              <option value="youth-savings" ${prev?.type === "youth-savings" ? "selected" : ""}>Youth Savings</option>
            </select></td></tr>
    <tr><td><label for="deposit">Initial Deposit (USD)</label></td>
        <td><input type="text" id="deposit" name="deposit" value="${prev?.deposit ?? ""}"></td></tr>
    <tr><td><label for="nickname">Account Nickname</label></td>
        <td><input type="text" id="nickname" name="nickname" value="${prev?.nickname ?? ""}"></td></tr>
    <tr><td colspan="2"><button type="submit">Continue</button></td></tr>
  </table>
</form>
<p><a href="/member/${member.id}">Back to Member Detail</a></p>`
  );
}

export function confirmationPage(member: Member, sub: { type: string; deposit: string; nickname: string }): string {
  return shell(
    "Confirm New Sub-Account",
    `
<h2>Confirm New Sub-Account</h2>
<table border="1" cellpadding="4">
  <tr><td>Member</td><td>${member.name} (${member.id})</td></tr>
  <tr><td>Account Type</td><td>${sub.type}</td></tr>
  <tr><td>Initial Deposit</td><td>$${sub.deposit}</td></tr>
  <tr><td>Nickname</td><td>${sub.nickname}</td></tr>
</table>
<form method="post" action="/member/${member.id}/confirm">
  <input type="hidden" name="type" value="${sub.type}">
  <input type="hidden" name="deposit" value="${sub.deposit}">
  <input type="hidden" name="nickname" value="${sub.nickname}">
  <button type="submit">Confirm &amp; Open Account</button>
</form>
<p><a href="/member/${member.id}">Cancel</a></p>`
  );
}

export function accountOpenedPage(member: Member): string {
  return shell(
    "Account Opened",
    `<h2 id="success-heading">Sub-Account Opened</h2><p>A new sub-account was opened for ${member.name} (${member.id}).</p><p><a href="/search">Back to Search</a></p>`
  );
}
