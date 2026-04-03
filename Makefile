
CC=cc
OSNAME := $(shell uname)

CFLAGS=-Wall -g -O2 -std=c99 -I/usr/local/rampart/include

ifeq ($(OSNAME), Linux)
	CFLAGS += -fPIC -shared -Wl,-soname,rampart-fontshuffle.so
endif
ifeq ($(OSNAME), Darwin)
	CFLAGS += -dynamiclib -Wl,-headerpad_max_install_names -undefined dynamic_lookup -install_name rampart-fontshuffle.so
endif

all: rampart-fontshuffle.so

rampart-fontshuffle.so: rampart-fontshuffle.c
	$(CC) $(CFLAGS) -o $@ $^

examples: rampart-fontshuffle.so
	@rm -rf examples-output
	@mkdir -p examples-output
	@rm -f examples/*-mappings.ws.json
	rampart webshield.js examples/index.html 77301 examples-output/ --guard --images
	@cp examples/screenshot-headless-stealth.png examples-output/
	rampart webshield.js examples/multifont-test.html 42 examples-output/
	@echo ""
	@echo "Output in examples-output/"

.PHONY: clean examples

clean:
	rm -f ./*.so
	rm -rf examples-output
	rm -f examples/*-mappings.ws.json

