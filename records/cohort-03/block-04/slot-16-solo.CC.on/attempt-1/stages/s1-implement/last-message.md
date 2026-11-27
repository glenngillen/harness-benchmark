Implemented the SQLite-backed job API, worker with progress, retries, recovery, and heartbeat, plus the polling browser UI.

`npm run build` and `git diff --check` pass. I couldn’t verify runtime checks here: the smoke and contract runners, and a direct server start, were blocked by `listen EPERM`.

Changed [src/db.ts](/opt/harness/work/.runs/campaign/cohort-03/block-04/slot-16-solo.CC.on/attempt-1/workspace/src/db.ts), [src/server.ts](/opt/harness/work/.runs/campaign/cohort-03/block-04/slot-16-solo.CC.on/attempt-1/workspace/src/server.ts), [src/worker.ts](/opt/harness/work/.runs/campaign/cohort-03/block-04/slot-16-solo.CC.on/attempt-1/workspace/src/worker.ts), and [ui/index.html](/opt/harness/work/.runs/campaign/cohort-03/block-04/slot-16-solo.CC.on/attempt-1/workspace/ui/index.html).