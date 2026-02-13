{
  description = "Codex Desktop for Linux - Nix flake for OpenAI Codex on Linux";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
  }:
    flake-utils.lib.eachSystem ["x86_64-linux" "aarch64-linux"] (
      system: let
        pkgs = nixpkgs.legacyPackages.${system};
      in {
        packages.default = pkgs.callPackage ./package.nix {};
        apps.default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/codex-desktop";
        };
      }
    );
}
