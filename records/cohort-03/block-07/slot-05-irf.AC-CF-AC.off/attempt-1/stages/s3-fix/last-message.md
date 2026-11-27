All three findings were correct, and I've fixed each one. The build passes, and both fixed suites pass (smoke 2/2, contract 5/5).

**1. Input corrupted by NUL and lone surrogates (major): fixed.** I confirmed that SQLite text binding truncates at `\u0000` and replaces lone surrogates. `input` and `output` are now stored as JSON-encoded text in `input_json` and `output_json`, and decoded when returned or claimed. `"a\u0000b\ud800c"` now round-trips exactly, and processing gives `"A\u0000B\ud800C"`.

**2. Attempt counter decreased on recovery (major): fixed.** `attempts` is never decremented now.
- An interrupted attempt with budget left goes back to `queued`, and the next claim uses the next number.
- An interrupted final attempt (`attempts` already 3) fails with `"transient failure"`, so the budget isn't reopened.

Repeated kills now give attempt numbers 1, 2, 3 and then a `failed` job with `attempts` 3.

**3. 16 KB body limit (minor): fixed.** I removed the size cap. A body of 17,000 spaces followed by `{"input":"hello"}` now returns `201`.

**Trade-off:** with the cap removed, an oversized body is buffered in memory. The spec sets no limit, so I followed the reviewer's first option. Tell me if you'd rather have a generous cap such as 1 MB.

**Changes outside the findings:** the `jobs` table columns are renamed to `input_json` and `output_json`. An existing `data/jobs.db` created by the earlier schema will not work with this code. Delete it, or point `DATABASE_PATH` at a new file.

**Verification notes:** my end-to-end test script had gone missing from `$TMPDIR`, so an earlier "exit=1" was a missing file, not a result. I recreated the script and reran it: all 29 checks pass, including SIGKILL recovery, no reprocessing of completed jobs, and the heartbeat going down on SIGTERM. A separate script covered the three findings. I haven't tested the page in a real browser.