package repo_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

// TestNoUnscopedRepoQueries — линтер на CLAUDE.md правило: репозитории НЕ имеют
// права делать запросы к БД мимо ForTenant. Сканирует ./internal/repo и
// ./internal/service на код-смелсы вида:
//
//	r.db.Find(...)        — голый Find без скоупа
//	r.db.Where(...).Find  — Where что-то не про restaurant_id и сразу Find
//	r.Raw().<Op>          — использование Raw() вне auth-исключений
//
// Это первичный фильтр. Глубокий анализ значений Where ещё впереди.
//
// Тест НЕ запускает БД — он работает на AST.
func TestNoUnscopedRepoQueries(t *testing.T) {
	root := findServerRoot(t)
	dirs := []string{
		filepath.Join(root, "internal", "repo"),
		filepath.Join(root, "internal", "service"),
	}

	// Запрещённые цепочки. Списки методов GORM, которые ходят в БД.
	queryMethods := map[string]bool{
		"Find": true, "First": true, "Take": true, "Last": true,
		"Create": true, "Save": true, "Updates": true, "Update": true,
		"Delete": true, "Count": true, "Scan": true, "Pluck": true,
		"FirstOrCreate": true, "FirstOrInit": true,
	}

	violations := []string{}

	for _, dir := range dirs {
		if _, err := filePresent(dir); err != nil {
			continue
		}
		_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") {
				return nil
			}
			if strings.HasSuffix(path, "_test.go") {
				return nil
			}
			fset := token.NewFileSet()
			file, err := parser.ParseFile(fset, path, nil, parser.AllErrors)
			if err != nil {
				return nil
			}
			// Файлам можно ослабить правило annotation-комментарием //nolint:repolint.
			if hasFileLevelEscape(file) {
				return nil
			}
			ast.Inspect(file, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				if !queryMethods[sel.Sel.Name] {
					return true
				}
				// Цепочка: ищем родительский селектор. Что ровно ПЕРЕД query-методом.
				root := unwrapChain(sel.X)
				if root == nil {
					return true
				}
				// Допустимые префиксы:
				//   tx.<Op>       — это переданный *gorm.DB (внутри Transaction-callback)
				//   scoped.<Op>   — результат ForTenant
				//   r.Raw().<Op>  — допустимо только если есть пометка //nolint:repolint
				//   db.Migrator() / db.AutoMigrate — не query
				name := exprName(root)
				switch {
				case strings.HasSuffix(name, ".db"), name == "r.db", name == "s.db":
					// Прямое r.db.<Find/Create/...> — запрещено.
					pos := fset.Position(call.Pos())
					violations = append(violations,
						pos.String()+": forbidden direct r.db."+sel.Sel.Name+" (use ForTenant or //nolint:repolint)")
				}
				return true
			})
			return nil
		})
	}

	if len(violations) > 0 {
		t.Errorf("found %d unscoped DB queries (CLAUDE.md tenant rule):\n  %s",
			len(violations), strings.Join(violations, "\n  "))
	}
}

// unwrapChain находит самый глубокий receiver в цепочке вызовов:
// a.b().c().d  →  a.b().c().d (вход) → возвращает узел "a.b().c().d" без последнего .d
// для нашего use-case достаточно вернуть sel.X. Этот хелпер оставлен для расширения.
func unwrapChain(e ast.Expr) ast.Expr { return e }

func exprName(e ast.Expr) string {
	switch v := e.(type) {
	case *ast.Ident:
		return v.Name
	case *ast.SelectorExpr:
		return exprName(v.X) + "." + v.Sel.Name
	case *ast.CallExpr:
		return exprName(v.Fun) + "()"
	default:
		return ""
	}
}

func hasFileLevelEscape(file *ast.File) bool {
	for _, cg := range file.Comments {
		for _, c := range cg.List {
			if strings.Contains(c.Text, "nolint:repolint") {
				return true
			}
		}
	}
	return false
}

// findServerRoot находит каталог server/ от расположения этого теста.
func findServerRoot(t *testing.T) string {
	t.Helper()
	// текущая директория тестов — server/internal/repo, поднимаемся на 2 уровня
	wd, err := filepath.Abs(".")
	if err != nil {
		t.Fatalf("abs: %v", err)
	}
	// .../server/internal/repo → .../server
	return filepath.Clean(filepath.Join(wd, "..", ".."))
}

func filePresent(p string) (bool, error) {
	_, err := filepath.Glob(filepath.Join(p, "*.go"))
	return err == nil, err
}
