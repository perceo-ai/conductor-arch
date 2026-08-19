VERSION ?= 0.1.0
DEV_ENV := scripts/dev-instance-env.sh

ifeq ($(OS),Windows_NT)
SHELL := C:/msys64/usr/bin/bash.exe
DEV_ENV := C:/msys64/usr/bin/bash.exe scripts/dev-instance-env.sh
endif

.PHONY: help dev-env archcar cli build build-release check release tag publish-tag \
	desktop-install desktop-dev desktop-build desktop-package desktop-package-linux

help:
	@printf '%s\n' \
		'make archcar                  Run archcar sidecar in branch-scoped dev mode' \
		'make cli                      Run CLI in branch-scoped dev mode' \
		'make dev-env                  Print branch-scoped dev environment' \
		'make build                    Build workspace in dev mode' \
		'make build-release            Build workspace in release mode' \
		'make check                    Run fmt, clippy, and tests' \
		'make release VERSION=x.y.z    Run local release gate and build packages' \
		'make tag VERSION=x.y.z        Create git tag vVERSION' \
		'make publish-tag VERSION=x.y.z Push git tag vVERSION' \
		'make desktop-install          Install Electron UI deps (pnpm)' \
		'make desktop-dev              Run Electron UI in dev mode (restarts branch sidecar)' \
		'make desktop-build            Build Electron UI bundles' \
		'make desktop-package          Build sidecars + package all installers' \
		'make desktop-package-linux    Build sidecars + Linux installers only'

dev-env:
	@$(DEV_ENV) --print

archcar:
	$(DEV_ENV) cargo run --bin archcar

cli:
	$(DEV_ENV) cargo run --bin archductor --

# The desktop UI is the Electron app: run `make desktop-dev` (it auto-spawns
# archcar). The old `make dev`/`gtk`/`run` GTK targets were retired with gtk-app.

build:
	cargo build --workspace

build-release:
	cargo build --workspace --release --locked

check:
	cargo fmt --all -- --check
	cargo clippy --workspace --all-targets --locked -- -D warnings
	cargo test --workspace --locked

release:
	scripts/release-readiness.sh --version $(VERSION) --package

tag:
	git tag -a v$(VERSION) -m "v$(VERSION)"

publish-tag:
	git push origin v$(VERSION)

# ---- Electron desktop UI (replaces the GTK app) ----

desktop-install:
	cd desktop && pnpm install

# Dev mode needs a concrete archcar binary. Restart the branch-scoped sidecar
# before rebuilding so Electron cannot reconnect to a stale daemon.
desktop-dev:
	$(DEV_ENV) scripts/stop-dev-archcar.sh
	$(DEV_ENV) cargo build --bin archcar
	$(DEV_ENV) bash -lc 'cd desktop && pnpm dev'

desktop-build:
	cd desktop && pnpm build

# Package needs the release sidecars (archcar, archductor) staged into
# target/release before electron-builder bundles them via extraResources.
desktop-package: build-release
	cd desktop && pnpm run dist

desktop-package-linux: build-release
	cd desktop && pnpm run dist:linux
