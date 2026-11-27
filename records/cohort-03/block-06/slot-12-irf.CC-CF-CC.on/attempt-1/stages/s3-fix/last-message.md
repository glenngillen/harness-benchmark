Fixed all four findings: the UI script now parses and sends invalid values to API validation, request bodies preserve UTF-8 across chunks, and unsupported methods on `/` return 405.

The build and inline UI script check pass. The worker starts and shuts down; the server could not bind because the sandbox returned `listen EPERM`.