# Build the AgentWorth C client + example. Requires libcurl (libcurl4-openssl-dev
# / curl-devel / `brew install curl`).
CFLAGS ?= -O2 -Wall -Wextra -std=c11
LDLIBS ?= -lcurl

example: example.c agentworth.c agentworth.h
	$(CC) $(CFLAGS) example.c agentworth.c -o example $(LDLIBS)

# Syntax-only check of the library (no link, still needs curl headers).
check: agentworth.c agentworth.h
	$(CC) $(CFLAGS) -fsyntax-only agentworth.c

clean:
	rm -f example

.PHONY: check clean
