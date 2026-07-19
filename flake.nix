{
  description = "Archductor parallel coding-agent workflow tool";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          archductor = pkgs.rustPlatform.buildRustPackage {
            pname = "archductor";
            version = "0.1.0";

            src = pkgs.lib.cleanSource ./.;
            cargoLock.lockFile = ./Cargo.lock;

            nativeBuildInputs = with pkgs; [
              pkg-config
              wrapGAppsHook4
            ];

            buildInputs = with pkgs; [
              gtk4
              libadwaita
              sqlite
            ];

            LIBSQLITE3_SYS_USE_PKG_CONFIG = "1";
            cargoBuildFlags = [ "--workspace" ];
            doCheck = false;

            installPhase = ''
              runHook preInstall

              release_dir="$(
                find target -type f -path '*/release/archductor' -executable \
                  -printf '%h\n' -quit
              )"
              if [ -z "$release_dir" ]; then
                echo "release binaries not found under target/" >&2
                find target -maxdepth 4 -type f -executable >&2
                exit 1
              fi

              install -Dm755 "$release_dir/archductor" "$out/bin/archductor"
              install -Dm755 "$release_dir/archductor-gtk" "$out/bin/archductor-gtk"
              install -Dm755 "$release_dir/archcar" "$out/bin/archcar"
              install -Dm644 packaging/archductor-gtk.desktop \
                "$out/share/applications/archductor-gtk.desktop"
              install -Dm644 packaging/archductor.svg \
                "$out/share/icons/hicolor/scalable/apps/archductor.svg"
              install -Dm644 README.md "$out/share/doc/archductor/README.md"

              runHook postInstall
            '';

            meta = with pkgs.lib; {
              description = "Parallel coding-agent workflow tool built around Git worktrees";
              homepage = "https://github.com/perceo-ai/conductor-arch";
              license = licenses.asl20;
              mainProgram = "archductor";
              platforms = platforms.linux;
            };
          };
        in
        {
          inherit archductor;
          default = archductor;
        });

      apps = forAllSystems (system: {
        archductor = {
          type = "app";
          program = "${self.packages.${system}.archductor}/bin/archductor";
        };
        archductor-gtk = {
          type = "app";
          program = "${self.packages.${system}.archductor}/bin/archductor-gtk";
        };
        default = self.apps.${system}.archductor;
      });

      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              cargo
              rustc
              rustfmt
              clippy
              pkg-config
              gtk4
              libadwaita
              git
              gh
              sqlite
              openssh
            ];
          };
        });

      formatter = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        pkgs.nixpkgs-fmt);
    };
}
