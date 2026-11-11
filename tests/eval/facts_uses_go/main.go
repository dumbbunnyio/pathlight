// Command facts_uses_go prints, for each Go file of a workspace and each package of the workspace it imports, whether the file uses that package
// anywhere other than in a type position, as decided by go/types (the compiler's own type checker), not by the scan's reading of the syntax.
// Standard library only: workspace packages are type-checked from source, every other import is an empty package (its uses are errors, which are
// ignored, so a file is judged only on the workspace packages it names). Build constraints are not evaluated, as the scan does not evaluate them.
// A composite literal's type (`pkg.T{}`) and an embedded field count as values: they build the other package's values.
//
// Usage: go run ./tests/eval/facts_uses_go DIR   (one JSON object per line: {"file", "dir", "value"})
package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

type module struct{ path, dir string }

var (
	root    string
	fset    = token.NewFileSet()
	modules []module
	checked = map[string]*types.Package{}
	files   = map[string][]*ast.File{}
	infos   = map[string]*types.Info{}
)

func dirOf(importPath string) (string, bool) {
	for _, m := range modules {
		if importPath == m.path {
			return m.dir, true
		}
		if strings.HasPrefix(importPath, m.path+"/") {
			return filepath.Join(m.dir, strings.TrimPrefix(importPath, m.path+"/")), true
		}
	}
	return "", false
}

type importer struct{}

func (importer) Import(path string) (*types.Package, error) {
	dir, ok := dirOf(path)
	if !ok {
		name := path[strings.LastIndex(path, "/")+1:]
		pkg := types.NewPackage(path, name)
		pkg.MarkComplete()
		return pkg, nil
	}
	return check(dir, path), nil
}

// check type-checks the package in dir once (files that are not tests), returning what it declares even when it has errors.
func check(dir, path string) *types.Package {
	if pkg, ok := checked[dir]; ok {
		if pkg == nil {
			return types.NewPackage(path, filepath.Base(dir))
		}
		return pkg
	}
	checked[dir] = nil
	entries, _ := os.ReadDir(dir)
	var parsed []*ast.File
	name := ""
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, filepath.Join(dir, entry.Name()), nil, parser.SkipObjectResolution)
		if err != nil || file == nil {
			continue
		}
		if name == "" {
			name = file.Name.Name
		}
		if file.Name.Name != name {
			continue
		}
		parsed = append(parsed, file)
	}
	info := &types.Info{Types: map[ast.Expr]types.TypeAndValue{}, Uses: map[*ast.Ident]types.Object{}}
	config := types.Config{Importer: importer{}, Error: func(error) {}, FakeImportC: true}
	pkg, _ := config.Check(path, fset, parsed, info)
	checked[dir], files[dir], infos[dir] = pkg, parsed, info
	return pkg
}

var vendored = regexp.MustCompile(`(^|/)vendor/`)

func main() {
	root, _ = filepath.Abs(os.Args[1])
	filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() && entry.Name() == "go.mod" && !vendored.MatchString(path) {
			text, _ := os.ReadFile(path)
			if found := regexp.MustCompile(`(?m)^\s*module\s+"?([^\s"]+)"?`).FindSubmatch(text); found != nil {
				modules = append(modules, module{string(found[1]), filepath.Dir(path)})
			}
		}
		if err == nil && entry.IsDir() && (entry.Name() == ".git" || entry.Name() == "node_modules") {
			return filepath.SkipDir
		}
		return nil
	})
	sort.Slice(modules, func(a, b int) bool { return len(modules[a].path) > len(modules[b].path) })
	var dirs []string
	filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err == nil && entry.IsDir() {
			if entry.Name() == ".git" || entry.Name() == "node_modules" || vendored.MatchString(path+"/") {
				return filepath.SkipDir
			}
			dirs = append(dirs, path)
		}
		return nil
	})
	out := json.NewEncoder(os.Stdout)
	for _, dir := range dirs {
		var importPath string
		for _, m := range modules {
			if dir == m.dir || strings.HasPrefix(dir, m.dir+"/") {
				suffix, _ := filepath.Rel(m.dir, dir)
				importPath = m.path
				if suffix != "." {
					importPath = m.path + "/" + filepath.ToSlash(suffix)
				}
				break
			}
		}
		if importPath == "" {
			continue
		}
		check(dir, importPath)
		info := infos[dir]
		for _, file := range files[dir] {
			value := map[string]bool{}
			seen := map[string]bool{}
			parents := map[ast.Node]ast.Node{}
			ast.Inspect(file, func(node ast.Node) bool {
				if node == nil {
					return true
				}
				ast.Inspect(node, func(child ast.Node) bool {
					if child != node && child != nil {
						if _, ok := parents[child]; !ok {
							parents[child] = node
						}
						return false
					}
					return true
				})
				return true
			})
			ast.Inspect(file, func(node ast.Node) bool {
				selector, ok := node.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				ident, ok := selector.X.(*ast.Ident)
				if !ok {
					return true
				}
				pkgName, ok := info.Uses[ident].(*types.PkgName)
				if !ok {
					return true
				}
				target, inWorkspace := dirOf(pkgName.Imported().Path())
				if !inWorkspace {
					return true
				}
				seen[target] = true
				isType := info.Types[selector].IsType()
				if parent, ok := parents[selector].(*ast.CompositeLit); ok && parent.Type == selector {
					isType = false
				}
				embedded := func(node ast.Node) bool {
					field, ok := node.(*ast.Field)
					if !ok || len(field.Names) != 0 {
						return false
					}
					_, inStruct := parents[parents[field]].(*ast.StructType)
					return inStruct
				}
				if star, ok := parents[selector].(*ast.StarExpr); embedded(parents[selector]) || ok && embedded(parents[star]) {
					isType = false
				}
				if !isType {
					value[target] = true
				}
				return true
			})
			fileRel, _ := filepath.Rel(root, fset.File(file.Pos()).Name())
			for target := range seen {
				targetRel, _ := filepath.Rel(root, target)
				out.Encode(map[string]any{"file": filepath.ToSlash(fileRel), "dir": filepath.ToSlash(targetRel), "value": value[target]})
			}
		}
	}
}
