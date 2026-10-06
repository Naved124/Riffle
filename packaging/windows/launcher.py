"""Entry point used by PyInstaller for the Windows build."""
import sys

from flashcard_viewer.app import main

if __name__ == "__main__":
    sys.exit(main())
