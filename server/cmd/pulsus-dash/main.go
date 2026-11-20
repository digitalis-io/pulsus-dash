// Command pulsus-dash is the Pulsus Dash BFF (ADR-0015).
package main

import "os"

func main() {
	os.Exit(run(signalContext(), runEnv{Args: os.Args[1:], Environ: os.Environ(), Stdout: os.Stdout, Stderr: os.Stderr}))
}
