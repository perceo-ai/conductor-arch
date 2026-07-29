VERSION ?= 0.1.0
DEV_ENV := scripts/dev-instance-env.sh

ifeq ($(OS),Windows_NT)
SHELL := C:/msys64/usr/bin/bash.exe
DEV_ENV := C:/msys64/usr/bin/bash.exe scripts/dev-instance-env.sh
endif

.PHONY: help dev dev-env archcar gtk cli run build build-release check release tag publish-tag \
	desktop-install desktop-dev desktop-build desktop-package desktop-package-linux

help:
	@printf '%s\n' \
		'make gtk                      Run GTK app in branch-scoped dev mode' \
		'make archcar                  Run archcar sidecar in branch-scoped dev mode' \
		'make cli                      Run CLI in branch-scoped dev mode' \
		'make run                      Alias for make gtk' \
		'make dev                      Run Archcar + GTK (r Reload GTK, q Quit)' \
		'make dev-env                  Print branch-scoped dev environment' \
		'make build                    Build workspace in dev mode' \
		'make build-release            Build workspace in release mode' \
		'make check                    Run fmt, clippy, and tests' \
		'make release VERSION=x.y.z    Run local release gate and build packages' \
		'make tag VERSION=x.y.z        Create git tag vVERSION' \
		'make publish-tag VERSION=x.y.z Push git tag vVERSION' \
		'make desktop-install          Install Electron UI deps (pnpm)' \
		'make desktop-dev              Run Electron UI in dev mode' \
		'make desktop-build            Build Electron UI bundles' \
		'make desktop-package          Build sidecars + package all installers' \
		'make desktop-package-linux    Build sidecars + Linux installers only'

dev:
	@$(DEV_ENV) cargo build --workspace
	@$(DEV_ENV) --run-dev

dev-env:
	@$(DEV_ENV) --print

archcar:
	$(DEV_ENV) cargo run --bin archcar

gtk:
	$(DEV_ENV) cargo run --bin archductor-gtk

cli:
	$(DEV_ENV) cargo run --bin archductor --

run: gtk

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

desktop-dev:
	cd desktop && pnpm dev

desktop-build:
	cd desktop && pnpm build

# Package needs the release sidecars (archcar, archductor) staged into
# target/release before electron-builder bundles them via extraResources.
desktop-package: build-release
	cd desktop && pnpm run dist

desktop-package-linux: build-release
	cd desktop && pnpm run dist:linux
