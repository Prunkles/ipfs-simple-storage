{
  stdenv,
  nodejs,
  pnpm_9,
  makeWrapper,
  dockerTools,
  pkgs,
  src,
  ...
}:
let
  pnpm = pnpm_9;
in
stdenv.mkDerivation (finalAttrs: {
  pname = "ipfs-simple-storage";
  version = "0.0.1";
  inherit src;

  pnpmDeps = pnpm.fetchDeps {
    inherit (finalAttrs) pname version src;
    hash = "sha256-xmoRYo++JvC4qnvVJP+L3EqnmGKGTnCppt9s65JbUXc=";
  };

  nativeBuildInputs = [
    nodejs
    pnpm.configHook
    makeWrapper
  ];

  preBuild = ''
    # Because @libp2p/webrtc depends on node-datachannel which does build scripts which are disabled by default with --ignore-scripts
    # But we don't use webrtc, so patch-out it
    substituteInPlace ./node_modules/.pnpm/node-datachannel@0.11.0/node_modules/node-datachannel/lib/node-datachannel.js \
      --replace-fail "require('../build/Release/node_datachannel.node')" '{}'
  '';

  buildPhase = ''
    runHook preBuild

    npm run build

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/node_modules
    cp -r ./. $out/lib/node_modules/ipfs-simple-storage

    mkdir -p $out/bin
    makeWrapper ${nodejs}/bin/node $out/bin/ipfs-simple-storage \
      --add-flags $out/lib/node_modules/ipfs-simple-storage/dist/index.js \
      --add-flags --

    runHook postInstall
  '';

  passthru = {
    dockerImage = dockerTools.buildLayeredImage {
      name = "ipfs-simple-storage";
      contents = [
        pkgs.busybox
        pkgs.cacert
      ];
      config = {
        Env = [
          "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
        ];
        Cmd = [ "${finalAttrs.finalPackage}/bin/ipfs-simple-storage" ];
      };
    };
  };
})
