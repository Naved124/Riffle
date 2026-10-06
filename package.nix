{
  lib,
  python3Packages,
  qt6,
}:

python3Packages.buildPythonApplication {
  pname = "flashcard-viewer";
  version = "1.0.2";
  pyproject = true;

  # Only what the build and tests need, so Android/Windows changes don't trigger rebuilds.
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./pyproject.toml
      ./README.md
      ./LICENSE
      ./flashcard_viewer
      ./packaging/flashcard-viewer.desktop
      ./packaging/release-signing-key.pem
      ./tests
      ./samples
      ./tools
    ];
  };

  build-system = [ python3Packages.setuptools ];

  dependencies = with python3Packages; [
    pyqt6
    pyqt6-webengine
    beautifulsoup4
  ];

  nativeBuildInputs = [ qt6.wrapQtAppsHook ];
  buildInputs = [
    qt6.qtbase
    qt6.qtwayland
  ];

  # Let the Python wrapper carry the Qt plugin paths instead of wrapping twice.
  dontWrapQtApps = true;
  preFixup = ''
    makeWrapperArgs+=("''${qtWrapperArgs[@]}")
  '';

  postInstall = ''
    install -Dm644 packaging/flashcard-viewer.desktop $out/share/applications/flashcard-viewer.desktop
    substituteInPlace $out/share/applications/flashcard-viewer.desktop \
      --replace-fail "@EXEC@" "flashcard-viewer"
    install -Dm644 flashcard_viewer/ui/icon.png $out/share/icons/hicolor/512x512/apps/flashcard-viewer.png
  '';

  nativeCheckInputs = [ python3Packages.pytestCheckHook ];
  pythonImportsCheck = [ "flashcard_viewer" ];

  meta = {
    description = "Material 3 desktop app for studying HTML / React flashcard decks";
    homepage = "https://github.com/Naved124/riffle";
    license = lib.licenses.unfreeRedistributable;
    mainProgram = "flashcard-viewer";
    platforms = lib.platforms.linux;
  };
}
