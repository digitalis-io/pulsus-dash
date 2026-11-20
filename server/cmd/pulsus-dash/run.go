package main

import (
	"context"
	"io"
	"net"
)

type runEnv struct {
	Args, Environ  []string
	Stdout, Stderr io.Writer
	Listener       net.Listener
	Ready          chan<- string
}

func signalContext() context.Context { return context.Background() }

// run is not implemented yet.
func run(ctx context.Context, e runEnv) int { return 0 }
