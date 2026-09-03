# Preview recordings

Records the CLI's scenarios under a real pseudo-terminal (100×50, one at 60
columns) for two builds — a published version and this branch's `dist` — and
renders the final terminal screens as HTML for a before/after review page.

```sh
pnpm build                                                  # this branch's bundle
(cd scripts/preview/before-pkg && npm pack @millionsend/cli@<version> && tar xzf *.tgz)
SKIP_ENV_VALIDATION=1 pnpm exec tsx scripts/preview/capture.mjs before after   # ~25 min
node scripts/preview/build-page.mjs                         # → out/cli-before-after.html
```

`capture.mjs` boots the fake Resend account and a real API on PGlite (the
same helpers the e2e uses), so nothing here touches a real account.
`pty-run.py` runs the bundle under a pty with a fixed window size and can
answer a prompt once (`--enter-on TEXT`); `vt.mjs` replays the raw output
through a small terminal emulator so in-place redraws collapse to the screen a
user ends up seeing; `ansi-to-html.mjs` turns that screen into `<pre>` markup.
