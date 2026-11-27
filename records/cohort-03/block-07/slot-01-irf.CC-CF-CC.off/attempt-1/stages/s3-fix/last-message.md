Addressed all three findings: request bodies now decode UTF-8 safely across chunks, restart recovery preserves attempt counts and enforces the three-attempt limit, and the form sends invalid values to the API for field-specific errors.

The build passes, and the worker recovery check passed. I could not verify HTTP server startup because this environment blocks socket binding with `EPERM`.