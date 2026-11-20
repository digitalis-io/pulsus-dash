package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/digitalis-io/pulsus-dash/server/internal/config"
)

// Exit codes.
const (
	exitOK      = 0
	exitRuntime = 1
	exitUsage   = 2
)

const usage = "usage: pulsus-dash <serve|migrate|config check|version> [flags]"

// runEnv is everything a command reads from or writes to the process, so tests can run the CLI
// in-process.
type runEnv struct {
	Args, Environ  []string
	Stdout, Stderr io.Writer
	Listener       net.Listener  // serve only; nil = listen on server.listen
	Ready          chan<- string // serve only; receives the bound address once listening
}

// signalContext is cancelled by SIGINT or SIGTERM. The process exits when run returns, so the
// stop function is not needed.
func signalContext() context.Context {
	ctx, _ := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	return ctx
}

// run executes one command and returns the process exit code.
func run(ctx context.Context, e runEnv) int {
	if len(e.Args) == 0 {
		return fail(e, exitUsage, usage)
	}
	switch e.Args[0] {
	case "serve":
		return cmdServe(ctx, e, e.Args[1:])
	case "migrate":
		return cmdMigrate(ctx, e, e.Args[1:])
	case "config":
		if len(e.Args) >= 2 && e.Args[1] == "check" {
			return cmdConfigCheck(e, e.Args[2:])
		}
	case "version":
		return cmdVersion(e, e.Args[1:])
	}
	return fail(e, exitUsage, usage)
}

// fail prints "pulsus-dash: <msg>" on stderr and returns code.
func fail(e runEnv, code int, msg string) int {
	_, _ = fmt.Fprintf(e.Stderr, "pulsus-dash: %s\n", msg)
	return code
}

// newFlags returns a flag set that reports errors on stderr instead of exiting.
func newFlags(e runEnv, name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(e.Stderr)
	return fs
}

// parseFlags parses args and refuses positional arguments.
func parseFlags(e runEnv, fs *flag.FlagSet, args []string) bool {
	if err := fs.Parse(args); err != nil {
		return false
	}
	if fs.NArg() > 0 {
		fail(e, exitUsage, fmt.Sprintf("unexpected argument %q", fs.Arg(0)))
		return false
	}
	return true
}

// loadConfig loads the configuration from the file at path ("" = none) and the environment.
func loadConfig(e runEnv, path string) (*config.Config, config.Sources, error) {
	src := config.Sources{ConfigPath: path, Environ: e.Environ}
	cfg, err := config.Load(src)
	return cfg, src, err
}
