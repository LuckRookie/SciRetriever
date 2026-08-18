"""Build and install the current source snapshot without touching the repository.

The helper deliberately creates a normal virtual environment with no system site
packages, installs all wheel runtime dependencies from the local uv cache in
offline mode, and runs every probe outside the repository.  Acceptance drivers
are copied into the temporary root before execution so their ``sys.path[0]``
cannot make repository tests importable.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]

_COPIED_FILES = ("README.md", "pyproject.toml")
_COPIED_TREES = ("src",)
_CLEARED_ENVIRONMENT_NAMES = frozenset(
    {
        "ALL_PROXY",
        "ANTHROPIC_API_KEY",
        "AWS_SESSION_TOKEN",
        "CURL_CA_BUNDLE",
        "FTP_PROXY",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "MINERU_TOKEN",
        "NO_PROXY",
        "OPENAI_API_KEY",
        "PIP_CONFIG_FILE",
        "PIP_EXTRA_INDEX_URL",
        "PIP_FIND_LINKS",
        "PIP_INDEX_URL",
        "PIP_TRUSTED_HOST",
        "PLAYWRIGHT_BROWSERS_PATH",
        "PYTHONHOME",
        "PYTHONPATH",
        "REQUESTS_CA_BUNDLE",
        "SCIRETRIEVER_CONFIG",
        "SSL_CERT_FILE",
        "UV_CACHE_DIR",
        "UV_DEFAULT_INDEX",
        "UV_EXTRA_INDEX_URL",
        "UV_FIND_LINKS",
        "UV_INDEX",
        "UV_INDEX_STRATEGY",
        "UV_INDEX_URL",
        "UV_KEYRING_PROVIDER",
    }
)


class InstalledWheelError(RuntimeError):
    """One isolated build or install step failed."""


@dataclass(frozen=True, slots=True)
class CommandResult:
    arguments: tuple[str, ...]
    returncode: int
    stdout: bytes
    stderr: bytes

    @property
    def stdout_text(self) -> str:
        return self.stdout.decode("utf-8", errors="strict")

    @property
    def stderr_text(self) -> str:
        return self.stderr.decode("utf-8", errors="strict")


class InstalledWheel:
    """One current-source wheel installed into one isolated temporary venv."""

    def __init__(self) -> None:
        self._temporary: tempfile.TemporaryDirectory[str] | None = None
        self.root: Path | None = None
        self.snapshot_root: Path | None = None
        self.wheel: Path | None = None
        self.venv: Path | None = None
        self.home: Path | None = None
        self.cwd: Path | None = None
        self.uv_cache: Path | None = None

    def __enter__(self) -> InstalledWheel:
        self.uv_cache = _uv_cache_directory()
        self._temporary = tempfile.TemporaryDirectory(prefix="sciretriever-acceptance-")
        self.root = Path(self._temporary.name).resolve(strict=True)
        self.snapshot_root = self.root / "source"
        self.venv = self.root / "venv"
        self.home = self.root / "home"
        self.cwd = self.root / "work"
        self.snapshot_root.mkdir(mode=0o700)
        self.home.mkdir(mode=0o700)
        self.cwd.mkdir(mode=0o700)
        try:
            self._copy_source_snapshot()
            self._build_wheel()
            self._create_venv()
            self._install_wheel()
        except BaseException:
            self.__exit__(*sys.exc_info())
            raise
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: object,
    ) -> None:
        del exc_type, exc_value, traceback
        temporary, self._temporary = self._temporary, None
        if temporary is not None:
            temporary.cleanup()

    @property
    def python(self) -> Path:
        return self._required(self.venv) / "bin" / "python"

    @property
    def console(self) -> Path:
        return self._required(self.venv) / "bin" / "sciretriever"

    @property
    def wheel_sha256(self) -> str:
        wheel = self._required(self.wheel)
        digest = hashlib.sha256()
        with wheel.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()

    @property
    def site_packages(self) -> Path:
        """Return the isolated interpreter's normal pure-Python install root."""

        result = self.run_python(
            ("-I", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))")
        )
        if result.returncode != 0 or result.stderr:
            raise InstalledWheelError("isolated site-packages lookup failed")
        try:
            path = Path(result.stdout_text.strip()).resolve(strict=True)
        except (OSError, ValueError):
            raise InstalledWheelError("isolated site-packages lookup failed") from None
        if not path.is_dir() or self._required(self.venv) not in path.parents:
            raise InstalledWheelError("isolated site-packages lookup escaped the venv")
        return path

    def install_sitecustomize(self, source: Path) -> Path:
        """Install one test-owned startup hook outside the product wheel."""

        if not source.is_file():
            raise ValueError("sitecustomize source is unavailable")
        target = self.site_packages / "sitecustomize.py"
        if target.exists():
            raise InstalledWheelError("isolated sitecustomize is already installed")
        shutil.copyfile(source, target)
        target.chmod(0o600)
        return target.resolve(strict=True)

    def install_startup_fixture(self, *sources: Path) -> tuple[Path, ...]:
        """Install test-owned startup modules into the isolated interpreter."""

        installed: list[Path] = []
        for source in sources:
            if not source.is_file() or source.suffix != ".py":
                raise ValueError("startup fixture source is unavailable")
            target = self.site_packages / source.name
            if target.exists():
                raise InstalledWheelError("isolated startup fixture is already installed")
            shutil.copyfile(source, target)
            target.chmod(0o600)
            installed.append(target.resolve(strict=True))
        return tuple(installed)

    def isolated_environment(
        self,
        extra: Mapping[str, str] | None = None,
    ) -> dict[str, str]:
        root = self._required(self.root)
        home = self._required(self.home)
        venv = self._required(self.venv)
        environment = {
            name: value
            for name, value in os.environ.items()
            if name.upper() not in _CLEARED_ENVIRONMENT_NAMES
        }
        environment.update(
            {
                "HOME": os.fspath(home),
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
                "PATH": os.pathsep.join((os.fspath(venv / "bin"), "/usr/bin", "/bin")),
                "PYTHONNOUSERSITE": "1",
                "PYTHONSAFEPATH": "1",
                "SCIRETRIEVER_ACCEPTANCE_ROOT": os.fspath(root),
                "UV_CACHE_DIR": os.fspath(self._required(self.uv_cache)),
                "UV_OFFLINE": "1",
            }
        )
        if extra is not None:
            for name, value in extra.items():
                if type(name) is not str or type(value) is not str:
                    raise TypeError("environment names and values must be strings")
                environment[name] = value
        return environment

    def run_console(
        self,
        arguments: Sequence[str],
        *,
        stdin: bytes | None = None,
        environment: Mapping[str, str] | None = None,
        cwd: Path | None = None,
        timeout: float = 30.0,
    ) -> CommandResult:
        return self._run(
            (os.fspath(self.console), *arguments),
            stdin=stdin,
            environment=environment,
            cwd=cwd,
            timeout=timeout,
        )

    def run_python(
        self,
        arguments: Sequence[str],
        *,
        stdin: bytes | None = None,
        environment: Mapping[str, str] | None = None,
        cwd: Path | None = None,
        timeout: float = 30.0,
    ) -> CommandResult:
        return self._run(
            (os.fspath(self.python), *arguments),
            stdin=stdin,
            environment=environment,
            cwd=cwd,
            timeout=timeout,
        )

    def run_driver(
        self,
        source: Path,
        arguments: Sequence[str] = (),
        *,
        environment: Mapping[str, str] | None = None,
        timeout: float = 30.0,
    ) -> CommandResult:
        if not source.is_file():
            raise ValueError("acceptance driver is unavailable")
        drivers = self._required(self.root) / "drivers"
        drivers.mkdir(mode=0o700, exist_ok=True)
        target = drivers / source.name
        shutil.copyfile(source, target)
        target.chmod(0o600)
        return self.run_python(
            (os.fspath(target), *arguments),
            environment=environment,
            timeout=timeout,
        )

    def _copy_source_snapshot(self) -> None:
        destination = self._required(self.snapshot_root)
        for relative in _COPIED_FILES:
            shutil.copyfile(REPOSITORY_ROOT / relative, destination / relative)
        for relative in _COPIED_TREES:
            shutil.copytree(
                REPOSITORY_ROOT / relative,
                destination / relative,
                ignore=shutil.ignore_patterns(
                    "__pycache__",
                    "*.egg-info",
                    "*.pyc",
                    "*.pyo",
                ),
            )

    def _build_wheel(self) -> None:
        root = self._required(self.root)
        snapshot = self._required(self.snapshot_root)
        wheel_directory = root / "wheel"
        wheel_directory.mkdir(mode=0o700)
        command = (
            sys.executable,
            "-m",
            "build",
            "--wheel",
            "--no-isolation",
            "--outdir",
            os.fspath(wheel_directory),
        )
        completed = subprocess.run(
            command,
            cwd=snapshot,
            env=self.isolated_environment(),
            check=False,
            capture_output=True,
            text=False,
            timeout=120,
        )
        if completed.returncode != 0:
            raise InstalledWheelError(
                "isolated wheel build failed: "
                + completed.stderr.decode("utf-8", errors="replace")[-2000:]
            )
        wheels = tuple(wheel_directory.glob("sciretriever-*.whl"))
        if len(wheels) != 1:
            raise InstalledWheelError("isolated wheel build did not produce exactly one wheel")
        self.wheel = wheels[0].resolve(strict=True)

    def _create_venv(self) -> None:
        completed = subprocess.run(
            (sys.executable, "-m", "venv", os.fspath(self._required(self.venv))),
            cwd=self._required(self.cwd),
            env=self.isolated_environment(),
            check=False,
            capture_output=True,
            text=False,
            timeout=60,
        )
        if completed.returncode != 0:
            raise InstalledWheelError("isolated virtual environment creation failed")

    def _install_wheel(self) -> None:
        completed = subprocess.run(
            (
                os.fspath(_uv_executable()),
                "pip",
                "install",
                "--offline",
                "--python",
                os.fspath(self.python),
                os.fspath(self._required(self.wheel)),
            ),
            cwd=self._required(self.cwd),
            env=self.isolated_environment(),
            check=False,
            capture_output=True,
            text=False,
            timeout=120,
        )
        if completed.returncode != 0:
            raise InstalledWheelError(
                "offline wheel install failed: "
                + completed.stderr.decode("utf-8", errors="replace")[-2000:]
            )

    def _run(
        self,
        command: Sequence[str],
        *,
        stdin: bytes | None,
        environment: Mapping[str, str] | None,
        cwd: Path | None,
        timeout: float,
    ) -> CommandResult:
        selected_cwd = self._required(self.cwd) if cwd is None else cwd
        completed = subprocess.run(
            tuple(command),
            cwd=selected_cwd,
            env=self.isolated_environment(environment),
            input=stdin,
            check=False,
            capture_output=True,
            text=False,
            timeout=timeout,
        )
        return CommandResult(
            arguments=tuple(command),
            returncode=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
        )

    @staticmethod
    def _required(value: Path | None) -> Path:
        if value is None:
            raise RuntimeError("installed wheel fixture is not active")
        return value


def _uv_executable() -> Path:
    selected = shutil.which("uv")
    if selected is None:
        raise InstalledWheelError("uv is required for the offline install acceptance")
    path = Path(selected).resolve(strict=True)
    mode = path.stat().st_mode
    if not stat.S_ISREG(mode) or not os.access(path, os.X_OK):
        raise InstalledWheelError("uv executable is unavailable")
    return path


def _uv_cache_directory() -> Path:
    completed = subprocess.run(
        (os.fspath(_uv_executable()), "cache", "dir"),
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )
    if completed.returncode != 0:
        raise InstalledWheelError("uv cache directory is unavailable")
    candidate = Path(completed.stdout.strip()).expanduser().resolve(strict=True)
    if not candidate.is_dir():
        raise InstalledWheelError("uv cache directory is unavailable")
    return candidate


__all__ = ("CommandResult", "InstalledWheel", "InstalledWheelError")
