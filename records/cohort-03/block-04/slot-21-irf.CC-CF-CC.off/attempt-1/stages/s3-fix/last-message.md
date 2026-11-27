Addressed all three findings: interrupted attempts replay without being marked as transient failures, malformed request URLs return JSON 404s, and request bodies are decoded after buffering to preserve split UTF-8 characters.

`npm run build` passes and the worker starts. The server cannot bind in this environment because localhost listening returns `EPERM`.