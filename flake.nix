{
  description = "vibes: a web UI for arclamp";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        # The images run on kokuzo, whatever builds them.
        pkgsLinux = import nixpkgs { system = "x86_64-linux"; };
        # A box image for this machine's own Docker, for local development.
        pkgsLocalLinux = import nixpkgs {
          system = if pkgs.stdenv.hostPlatform.isAarch64 then "aarch64-linux" else "x86_64-linux";
        };
        nodejs = pkgsLinux.nodejs_24;
        tag = self.rev or self.dirtyRev or "dev";

        # Just what building and running vibes needs: never .env, the
        # database, notes or the local arclamp harness.
        src = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions [
            ./package.json
            ./pnpm-lock.yaml
            ./pnpm-workspace.yaml
            ./tsconfig.server.json
            ./tsconfig.web.json
            ./tsconfig.box.json
            ./vite.config.ts
            ./src
            ./box
            # The sketch library, whose color core vibes uses too (src/shared/lemtone.ts).
            ./packages/vibes/src
          ];
        };

        # Built with the dependencies from the lockfile, the same for both.
        withPnpm =
          p: attrs:
          p.stdenv.mkDerivation (
            finalAttrs:
            {
              version = "0.0.0";
              inherit src;
              nativeBuildInputs = [
                p.nodejs_24
                p.pnpm_11
                p.pnpmConfigHook
              ];
              pnpmDeps = p.fetchPnpmDeps {
                inherit (finalAttrs) pname version src;
                pnpm = p.pnpm_11;
                fetcherVersion = 4;
                hash = "sha256-wBxb6stMCZ+Vf92CGhD4QaJfdMb+p6JQNAYBYvq5fRY=";
              };
            }
            // attrs
          );

        # The web app built, the server's sources as they run (Node strips the
        # types), and the production dependencies.
        vibes = withPnpm pkgsLinux {
          pname = "vibes";
          buildPhase = ''
            runHook preBuild
            pnpm build
            pnpm prune --prod
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            mkdir -p $out
            cp -r package.json src packages dist node_modules $out/
            runHook postInstall
          '';
        };

        # A sketch's box (src/server/boxes.ts): one person's VS Code for one
        # sketch (openvscode-server), the tools a sketch might be built with,
        # git, and vibes' extension (box/extension), started by box/start.sh.
        boxImageFor =
          p:
          let
            extension = withPnpm p {
              pname = "vibes-box-extension";
              buildPhase = ''
                runHook preBuild
                pnpm build:box
                runHook postBuild
              '';
              installPhase = ''
                runHook preInstall
                cp -r box/dist/vibes-sketch $out
                runHook postInstall
              '';
              # Plain files for VS Code to load: nothing to patch.
              dontFixup = true;
            };
            # Everyone's box starts with these; a person's own settings are kept in their browser.
            settings = p.writeText "vibes-box-settings.json" (
              builtins.toJSON {
                "workbench.colorTheme" = "Default Dark Modern";
                "workbench.startupEditor" = "none";
                "workbench.secondarySideBar.defaultVisibility" = "hidden";
                "chat.disableAIFeatures" = true;
                "files.autoSave" = "afterDelay";
                "git.autofetch" = true;
                "git.confirmSync" = false;
                # Sync puts your commits on top of main's latest, as pulling does (box/start.sh).
                "git.rebaseWhenSync" = true;
                "terminal.integrated.hideOnStartup" = "always";
                "window.commandCenter" = false;
                "editor.minimap.enabled" = false;
                "telemetry.telemetryLevel" = "off";
              }
            );
            start = p.writeShellApplication {
              name = "vibes-box-start";
              runtimeInputs = [
                p.openvscode-server
                p.git
                p.jq
                p.coreutils
                p.findutils
              ];
              text = builtins.readFile ./box/start.sh;
            };
            # The person, as uid 1000 (VS Code and git look themselves up), and
            # Nix's build users.
            users = p.runCommand "vibes-box-users" { } ''
              mkdir -p $out/etc
              {
                printf '%s\n' 'root:x:0:0:root:/root:/bin/sh' 'vibes:x:1000:1000:vibes:/home/workspace:/bin/bash' 'nobody:x:65534:65534:nobody:/var/empty:/bin/sh'
                for i in $(seq 1 8); do echo "nixbld$i:x:$((30000 + i)):30000:Nix build user $i:/var/empty:/bin/false"; done
              } >$out/etc/passwd
              printf '%s\n' 'root:x:0:' 'vibes:x:1000:' 'nobody:x:65534:' "nixbld:x:30000:$(seq -s, -f 'nixbld%g' 1 8)" >$out/etc/group
              printf '%s\n' 'hosts: files dns' >$out/etc/nsswitch.conf
            '';
            # Nix, first-class: a sketch with a flake builds with it. Its daemon
            # runs as root in the VM (box/agent.ts, box/builder.ts), running
            # builds as its build users; Nix's own sandbox is off, since the VM
            # is the sandbox. The store is the VM's own, fresh each time.
            nixConf = p.writeText "nix.conf" ''
              experimental-features = nix-command flakes
              build-users-group = nixbld
              sandbox = false
              max-jobs = auto
              substituters = https://cache.nixos.org/
              trusted-public-keys = cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=
            '';
          in
          p.dockerTools.buildLayeredImage {
            name = "kokuzo.tailc38f.ts.net/vibes-box";
            inherit tag;
            contents = [
              p.dockerTools.binSh
              p.dockerTools.usrBinEnv
              p.dockerTools.caCertificates
              p.bashInteractive
              p.coreutils
              p.gnused
              p.gnugrep
              p.findutils
              p.less
              p.procps
              p.git
              p.nodejs_24
              p.pnpm_11
              # mount and umount, for its agent.
              p.util-linuxMinimal
              # For builds (box/builder.ts), which unpack the commit vibes sends.
              p.gnutar
              p.gzip
              p.nix
            ];
            # Nix knows the store paths the image came with.
            includeNixDB = true;
            # Where the homes are given (/homes) and where the person's goes
            # (/home/workspace). Who's who as real files, which Docker reads to
            # run commands in it.
            fakeRootCommands = ''
              mkdir -p home/workspace homes tmp etc/nix
              chown 1000:1000 home/workspace
              chmod 0700 homes
              chmod 1777 tmp
              cp ${users}/etc/passwd ${users}/etc/group ${users}/etc/nsswitch.conf etc/
              cp ${nixConf} etc/nix/nix.conf
            '';
            config = {
              # Its agent, as root until it starts VS Code as the person (box/agent.ts).
              Entrypoint = [
                (p.lib.getExe p.nodejs_24)
                "${./box/agent.ts}"
                (p.lib.getExe start)
              ];
              WorkingDir = "/";
              Env = [
                "HOME=/home/workspace"
                "PATH=/bin:/usr/bin"
                "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
                # Everyone but root reaches the store through the daemon.
                "NIX_REMOTE=daemon"
                "VIBES_EXTENSION=${extension}"
                "VIBES_SETTINGS=${settings}"
              ];
              ExposedPorts."3000/tcp" = { };
            };
          };
        boxImage = boxImageFor pkgsLinux;
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.pnpm_11
          ];
        };

        formatter = pkgs.nixfmt-tree;

        packages = rec {
          default = vibes;

          dockerImage = pkgsLinux.dockerTools.buildLayeredImage {
            name = "kokuzo.tailc38f.ts.net/vibes";
            inherit tag;
            # git, for sketches' repos; a /tmp, for making them.
            contents = [ pkgsLinux.git ];
            extraCommands = "mkdir -m 1777 tmp";
            config = {
              Entrypoint = [
                "${nodejs}/bin/node"
                "src/server/index.ts"
              ];
              # The server finds the web app at ./dist/web.
              WorkingDir = "${vibes}";
              Env = [
                "NODE_ENV=production"
                "NODE_EXTRA_CA_CERTS=${pkgsLinux.cacert}/etc/ssl/certs/ca-bundle.crt"
              ];
              ExposedPorts."8787/tcp" = { };
            };
          };

          inherit boxImage;
          # For this machine's Docker: nix build .#boxImageLocal && docker load < result
          boxImageLocal = boxImageFor pkgsLocalLinux;

          # Both images, from a runner on kokuzo, to kokuzo's registry. skopeo
          # rather than the runner image's own push-docker-image, whose
          # uploads the registry (distribution v3) refuses as "size invalid".
          # The registry's certificate is for kokuzo.tailc38f.ts.net, hence no
          # TLS verification, as with push-docker-image's --insecure. The
          # runner image has no /var/tmp, skopeo's default.
          pushDockerImageActions = pkgs.writeShellScriptBin "push-docker-image" ''
            echo "pushing ${tag}"
            tmp=$(mktemp -d)
            trap 'rm -rf "$tmp"' EXIT
            for image in vibes:${dockerImage} vibes-box:${boxImage}; do
              ${pkgs.skopeo}/bin/skopeo --insecure-policy --tmpdir "$tmp" copy --dest-tls-verify=false \
                "docker-archive:''${image#*:}" \
                "docker://kokuzo-access.arc-runners.svc.cluster.local/''${image%%:*}:${tag}"
            done
          '';
        };
      }
    );
}
