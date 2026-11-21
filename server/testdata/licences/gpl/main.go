// Package main is the ci:go-licenses failing fixture: it links a GPL-2.0-only module.
package main

import dep "example.com/gpl-dep"

func main() { dep.Hello() }
