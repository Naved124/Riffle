{
  description = "Riffle - study HTML / React flashcard decks";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems =
        f:
        nixpkgs.lib.genAttrs systems (
          system:
          f (
            import nixpkgs {
              inherit system;
              # The license is freeware (unfree to Nix); allow just this package so `nix run` works as-is.
              config.allowUnfreePredicate = pkg: nixpkgs.lib.getName pkg == "flashcard-viewer";
            }
          )
        );
    in
    {
      packages = forAllSystems (pkgs: rec {
        flashcard-viewer = pkgs.callPackage ./package.nix { };
        default = flashcard-viewer;
      });

      overlays.default = final: prev: {
        flashcard-viewer = final.callPackage ./package.nix { };
      };

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          inputsFrom = [ self.packages.${pkgs.system}.default ];
          packages = [ pkgs.python3Packages.pytest ];
        };
      });
    };
}
