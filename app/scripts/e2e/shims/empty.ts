// Stands in for the `server-only` package when the E2E harness runs outside
// Next. The real package throws on import to stop server code reaching a
// client bundle — a protection that is meaningless in a Node script and
// would only stop the harness from testing the very code it exists to test.
export {};
