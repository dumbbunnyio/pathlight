#!/usr/bin/env python3
"""python3 -I tests/eval/facts_python.py WORKSPACE

An independent answer to "which workspace file does each Python import reach", for tests/eval/facts-python.ts to compare with `pathlight scan`.
CPython's own `ast` finds the statements and `importlib.machinery.PathFinder.find_spec` resolves them, with the search path set to the project's
roots (the directory of each pyproject.toml, setup.py or setup.cfg, its src/, a package-dir it names, then the workspace root; the nearest root at or
above a file first). Nothing here reads the scanner's code. Like the scan, a name imported from a package is followed through the package's
__init__.py to the module that binds it; here the binding is found as the interpreter would, the last module-level statement that binds the name.

Prints JSON: {"pairs": [[from, to, specifier], ...], "errors": [[file, message], ...]}.
"""
import ast
import configparser
import json
import os
import subprocess
import sys
import tomllib
from importlib.machinery import PathFinder

root = os.path.realpath(sys.argv[1])


def listed():
    try:
        out = subprocess.run(["git", "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], capture_output=True, check=True).stdout
        return sorted({p for p in out.decode().split("\0") if p})
    except (subprocess.CalledProcessError, FileNotFoundError):
        found = []
        for directory, dirs, names in os.walk(root):
            dirs[:] = [d for d in dirs if d not in (".git", ".cache", "node_modules")]
            found += [os.path.relpath(os.path.join(directory, n), root) for n in names]
        return sorted(found)


paths = listed()
sources = [p for p in paths if p.endswith(".py") and os.path.isfile(os.path.join(root, p)) and not os.path.islink(os.path.join(root, p))]
source_set = set(sources)


def package_dirs_from(config_path):
    """Directories a project configuration names as where its packages live."""
    full = os.path.join(root, config_path)
    base = os.path.dirname(config_path)
    found = []
    try:
        if config_path.endswith("pyproject.toml"):
            data = tomllib.load(open(full, "rb"))
            mapping = data.get("tool", {}).get("setuptools", {}).get("package-dir", {}) or {}
            for name, directory in mapping.items():
                if name == "":
                    found.append(directory)
                elif directory.rstrip("/").endswith("/" + name.replace(".", "/")):
                    found.append(directory.rstrip("/")[: -len(name) - 1])
            for package in data.get("tool", {}).get("poetry", {}).get("packages", []) or []:
                if isinstance(package, dict) and "from" in package:
                    found.append(package["from"])
        elif config_path.endswith("setup.cfg"):
            parser = configparser.ConfigParser()
            parser.read(full)
            value = parser.get("options", "package_dir", fallback="")
            for line in value.splitlines():
                key, _, directory = line.partition("=")
                if key.strip() == "" and directory.strip():
                    found.append(directory.strip())
        elif config_path.endswith("setup.py"):
            for node in ast.walk(ast.parse(open(full, encoding="utf-8").read())):
                if isinstance(node, ast.keyword) and node.arg == "package_dir" and isinstance(node.value, ast.Dict):
                    for key, value in zip(node.value.keys, node.value.values):
                        if isinstance(key, ast.Constant) and key.value == "" and isinstance(value, ast.Constant):
                            found.append(value.value)
    except (OSError, ValueError, SyntaxError, configparser.Error):
        pass
    return [os.path.normpath(os.path.join(base, d)) if base or d not in ("", ".") else "" for d in found]


roots = {""}
for p in paths:
    if os.path.basename(p) in ("pyproject.toml", "setup.py", "setup.cfg"):
        base = os.path.dirname(p)
        roots.add(base)
        if os.path.isdir(os.path.join(root, base, "src")):
            roots.add(os.path.join(base, "src") if base else "src")
        roots.update(d if d != "." else "" for d in package_dirs_from(p))
by_depth = sorted(roots, key=lambda r: (-len(r), r))


def roots_for(path):
    inside = [r for r in by_depth if r == "" or path.startswith(r + "/")]
    return inside + [r for r in by_depth if r not in inside]


def absolute(rel):
    return os.path.join(root, rel) if rel else root


def search_path(rel):
    """sys.path for a file: its roots, nearest first, searched together as the interpreter searches sys.path."""
    return [absolute(r) for r in roots_for(rel)]


def relative_file(spec):
    """The workspace file a spec was found in, or None (a namespace package, a built-in, a file outside the listing)."""
    if spec is None or not spec.origin or not spec.has_location:
        return None
    rel = os.path.relpath(os.path.realpath(spec.origin), root)
    return rel if rel in source_set else None


def find(dotted, locations):
    """PathFinder walked one segment at a time, as the import system does: each package's __path__ is where its submodules are looked for. Each step
    is asked for the segment alone (the finders look only at the last part of a name; a dotted one would make a namespace package look up its parent
    in sys.modules, which this never imports)."""
    spec = None
    for index in range(len(dotted)):
        if locations is None:
            return None
        spec = PathFinder.find_spec(dotted[index], locations)
        if spec is None:
            return None
        locations = list(spec.submodule_search_locations) if spec.submodule_search_locations is not None else None
    return spec


trees = {}


def tree_of(rel):
    if rel not in trees:
        try:
            trees[rel] = ast.parse(open(os.path.join(root, rel), encoding="utf-8").read(), filename=rel)
        except (SyntaxError, UnicodeDecodeError, ValueError) as error:
            trees[rel] = error
    return trees[rel]


def module_statements(body):
    """Statements that run at module level: into if/try/with blocks, not into functions or classes."""
    for node in body:
        yield node
        for field in ("body", "orelse", "finalbody", "handlers"):
            nested = getattr(node, field, None)
            if isinstance(node, (ast.If, ast.Try, ast.With, ast.For, ast.While)) and isinstance(nested, list):
                yield from module_statements(nested)
            elif isinstance(node, ast.Try) and field == "handlers":
                for handler in node.handlers:
                    yield from module_statements(handler.body)


def resolve_from(rel, node):
    """The module a `from … import` statement names, as (spec, search locations) or None."""
    if node.level:
        base = os.path.dirname(rel)
        for _ in range(node.level - 1):
            if not base:
                return None
            base = os.path.dirname(base)
        dotted = node.module.split(".") if node.module else []
        if not dotted:
            return ("package", [absolute(base)], base)
        spec = find(dotted, [absolute(base)])
        return (spec, None, None) if spec else None
    spec = find(node.module.split("."), search_path(rel))
    return (spec, None, None) if spec else None


def module_of(package_file, node):
    """The file and the submodule search path of the module a `from … import` in `package_file` names: (file or None, locations or None)."""
    found = resolve_from(package_file, node)
    if not found:
        return None, None
    spec, locations, base = found
    if spec == "package":
        file = os.path.join(base, "__init__.py") if base else "__init__.py"
        return (file if file in source_set else None), locations
    return relative_file(spec), (list(spec.submodule_search_locations) if spec.submodule_search_locations is not None else None)


def provides(module_file, name, depth, seen):
    """Where `name` comes from if `from module import *` would bind it, else None."""
    if not module_file:
        return None
    if module_file.endswith("__init__.py"):
        target = binding(module_file, name, depth + 1, seen)
        return target if target != module_file or defines(module_file, name) else None
    return module_file if defines(module_file, name) else None


def binding(package_file, name, depth=0, seen=None):
    """The file that binds `name` in a package's __init__.py, following the import that binds it there; the package itself if nothing does. The
    interpreter keeps the last binding, so the statements are read from the end; a star import binds the name only if its module has it."""
    seen = seen if seen is not None else set()
    if depth > 16 or (package_file, name) in seen:
        return package_file
    seen.add((package_file, name))
    tree = tree_of(package_file)
    if isinstance(tree, Exception):
        return package_file
    candidates = []
    for node in module_statements(tree.body):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == name:
            candidates.append(("self",))
        elif isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            candidates.append(("self",))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == name and node.value is not None:
            candidates.append(("self",))
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name == "*":
                    candidates.append(("star", node))
                elif (alias.asname or alias.name) == name:
                    candidates.append(("from", node, alias.name))
    for candidate in reversed(candidates):
        if candidate[0] == "self":
            return package_file
        module_file, locations = module_of(package_file, candidate[1])
        if candidate[0] == "star":
            target = provides(module_file, name, depth, seen)
            if target:
                return target
            continue
        imported = candidate[2]
        sub = find([imported], locations) if locations is not None else None
        if sub is not None and relative_file(sub):
            return relative_file(sub)
        if module_file and module_file.endswith("__init__.py"):
            return binding(module_file, imported, depth + 1, seen)
        return module_file or package_file
    return package_file


def defines(rel, name):
    tree = tree_of(rel)
    if isinstance(tree, Exception):
        return False
    for node in module_statements(tree.body):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == name:
            return True
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return True
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == name:
            return True
    return False


pairs, errors = set(), []


def add(source, target, specifier):
    if target and target != source:
        pairs.add((source, target, specifier))


for rel in sources:
    tree = tree_of(rel)
    if isinstance(tree, Exception):
        errors.append([rel, str(tree)])
        continue
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                add(rel, relative_file(find(alias.name.split("."), search_path(rel))), alias.name)
        elif isinstance(node, ast.ImportFrom):
            specifier = "." * node.level + (node.module or "")
            found = resolve_from(rel, node)
            if not found:
                continue
            spec, locations, base = found
            module_locations = locations if spec == "package" else (list(spec.submodule_search_locations) if spec.submodule_search_locations is not None else None)
            module_file = (os.path.join(base, "__init__.py") if base else "__init__.py") if spec == "package" else relative_file(spec)
            if module_file not in source_set:
                module_file = None
            for alias in node.names:
                if alias.name == "*":
                    add(rel, module_file, specifier)
                    continue
                sub = find([alias.name], module_locations) if module_locations is not None else None
                if sub is not None:
                    add(rel, relative_file(sub), specifier)
                elif module_file and module_file.endswith("__init__.py"):
                    add(rel, binding(module_file, alias.name), specifier)
                else:
                    add(rel, module_file, specifier)
        elif isinstance(node, ast.Call) and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
            function = node.func
            called = function.attr if isinstance(function, ast.Attribute) else function.id if isinstance(function, ast.Name) else None
            owner = function.value.id if isinstance(function, ast.Attribute) and isinstance(function.value, ast.Name) else None
            if (called == "import_module" and owner in (None, "importlib")) or (called == "__import__" and owner is None):
                name = node.args[0].value
                if name and not name.startswith("."):
                    add(rel, relative_file(find(name.split("."), search_path(rel))), name)

json.dump({"roots": by_depth, "pairs": sorted(pairs), "errors": errors}, sys.stdout)
