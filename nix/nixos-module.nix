{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.chudcode;
in
{
  options.programs.chudcode = {
    enable = lib.mkEnableOption "Chudcode coding agent";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.chudcode.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "Chudcode package to install system-wide.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];
  };
}
