import express from "express";
import crypto from "node:crypto";
import { members, sessions, MIN_INITIAL_DEPOSIT } from "./data.js";
import {
  loginPage,
  searchPage,
  memberDetailPage,
  memberNotFoundPage,
  supervisorRequiredPage,
  openSubAccountForm,
  confirmationPage,
  accountOpenedPage,
  sessionNoticePage,
  slowLoadPage,
} from "./views.js";

const app = express();
app.use(express.urlencoded({ extended: true }));

function getCookie(req: express.Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  const match = raw.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return match?.split("=")[1];
}

function requireSession(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = getCookie(req, "session");
  if (!token || !sessions.has(token)) {
    res.redirect("/login");
    return;
  }
  next();
}

const INJECT_MODES = new Set(["slow", "interstitial", "timeout"]);

/**
 * Test-only fault injector: `?inject=slow|interstitial|timeout` on any GET route renders that
 * condition instead of the route's real response. Entirely opt-in via the query param, so
 * uninjected requests (the default, and every route except the query string itself) are
 * byte-for-byte unchanged. Exists so replay's recoverable-error handling can be exercised
 * deterministically rather than waiting for a real slow network or interstitial to occur.
 */
app.get("*", (req, res, next) => {
  const inject = req.query.inject as string | undefined;
  if (!inject || !INJECT_MODES.has(inject) || req.path === "/login") {
    next();
    return;
  }
  const target = req.path;
  if (inject === "timeout") {
    res.redirect("/login");
  } else if (inject === "interstitial") {
    res.send(sessionNoticePage(target));
  } else {
    res.send(slowLoadPage(target));
  }
});

app.get("/login", (_req, res) => {
  res.send(loginPage());
});

app.post("/login", (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).send(loginPage("Username and password are required."));
    return;
  }
  const token = crypto.randomUUID();
  sessions.set(token, { username });
  res.setHeader("Set-Cookie", `session=${token}; HttpOnly; Path=/`);
  res.redirect("/search");
});

app.get("/search", requireSession, (req, res) => {
  const q = (req.query.q as string | undefined)?.trim();
  if (q === undefined) {
    res.send(searchPage());
    return;
  }
  const results = Object.values(members).filter(
    (m) => m.id === q || m.name.toLowerCase().includes(q.toLowerCase())
  );
  res.send(searchPage(q, results));
});

app.get("/member/:id", requireSession, (req, res) => {
  const member = members[req.params.id];
  if (!member) {
    res.status(404).send(memberNotFoundPage(req.params.id));
    return;
  }
  res.send(memberDetailPage(member));
});

app.get("/member/:id/open-subaccount", requireSession, (req, res) => {
  const member = members[req.params.id];
  if (!member) {
    res.status(404).send(memberNotFoundPage(req.params.id));
    return;
  }
  if (member.flaggedForReview) {
    res.send(supervisorRequiredPage(member));
    return;
  }
  res.send(openSubAccountForm(member));
});

app.post("/member/:id/open-subaccount/override", requireSession, (req, res) => {
  const member = members[req.params.id];
  if (!member) {
    res.status(404).send(memberNotFoundPage(req.params.id));
    return;
  }
  // One-time override for this demo session: proceed to the form.
  res.send(openSubAccountForm(member));
});

app.post("/member/:id/open-subaccount", requireSession, (req, res) => {
  const member = members[req.params.id];
  if (!member) {
    res.status(404).send(memberNotFoundPage(req.params.id));
    return;
  }
  const { type, deposit, nickname } = req.body as { type?: string; deposit?: string; nickname?: string };
  const amount = Number(deposit);
  if (!deposit || Number.isNaN(amount) || amount < MIN_INITIAL_DEPOSIT) {
    res
      .status(422)
      .send(
        openSubAccountForm(
          member,
          `Initial deposit must be at least $${MIN_INITIAL_DEPOSIT.toFixed(2)}.`,
          { type, deposit, nickname }
        )
      );
    return;
  }
  res.send(confirmationPage(member, { type: type ?? "standard-savings", deposit, nickname: nickname ?? "" }));
});

app.post("/member/:id/confirm", requireSession, (req, res) => {
  const member = members[req.params.id];
  if (!member) {
    res.status(404).send(memberNotFoundPage(req.params.id));
    return;
  }
  res.send(accountOpenedPage(member));
});

app.get("/", (_req, res) => res.redirect("/search"));

export { app };
