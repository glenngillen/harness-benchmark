Implemented the SQLite-backed API, asynchronous worker with retries and restart recovery, and polling browser UI.

`npm run build` passes. Both specified checks stopped before testing the app because the environment denied local socket creation (`listen EPERM`), so I couldn’t verify startup or HTTP behavior here.