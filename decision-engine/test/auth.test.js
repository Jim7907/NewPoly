const test = require("node:test");
const assert = require("node:assert");

test("basic auth: disabled without a password, enforced with one", () => {
  delete require.cache[require.resolve("../server/auth")];
  delete process.env.DASHBOARD_PASSWORD;
  let a = require("../server/auth");
  assert.equal(a.enabled(), false);
  assert.equal(a.checkHeader(undefined), true);
  delete require.cache[require.resolve("../server/auth")];
  process.env.DASHBOARD_PASSWORD = "s3cret:with:colons";
  process.env.DASHBOARD_USER = "jim";
  a = require("../server/auth");
  const hdr = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
  assert.equal(a.checkHeader(hdr("jim", "s3cret:with:colons")), true);
  assert.equal(a.checkHeader(hdr("jim", "wrong")), false);
  assert.equal(a.checkHeader(hdr("admin", "s3cret:with:colons")), false);
  assert.equal(a.checkHeader(undefined), false);
  delete process.env.DASHBOARD_PASSWORD; delete process.env.DASHBOARD_USER;
  delete require.cache[require.resolve("../server/auth")];
});
