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
        # The image runs on kokuzo, whatever builds it.
        pkgsLinux = import nixpkgs { system = "x86_64-linux"; };
        nodejs = pkgsLinux.nodejs_24;
        pnpm = pkgsLinux.pnpm_11;
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
            ./vite.config.ts
            ./src
          ];
        };

        # The web app built, the server's sources as they run (Node strips the
        # types), and the production dependencies.
        vibes = pkgsLinux.stdenv.mkDerivation (finalAttrs: {
          pname = "vibes";
          version = "0.0.0";
          inherit src;

          nativeBuildInputs = [
            nodejs
            pnpm
            pkgsLinux.pnpmConfigHook
          ];
          pnpmDeps = pkgsLinux.fetchPnpmDeps {
            inherit (finalAttrs) pname version src;
            inherit pnpm;
            fetcherVersion = 4;
            hash = "sha256-6b0EBt7hzUq18csz+LbSeQVhDNrjCAw0tIrebEFrBew=";
          };

          buildPhase = ''
            runHook preBuild
            pnpm build
            pnpm prune --prod
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p $out
            cp -r package.json src dist node_modules $out/
            runHook postInstall
          '';
        });
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

          pushDockerImageActions = pkgs.writeShellScriptBin "push-docker-image" ''
            echo "pushing ${tag}"
            push-docker-image ${dockerImage}
          '';
        };
      }
    );
}
