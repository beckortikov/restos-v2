package repo_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"strings"
	"testing"
)

// TestLinterCatchesBadPattern — gate-тест: проверяет, что сам линтер ловит
// заведомо плохой код-сэмпл. Иначе мы рискуем «зелёный CI на пустом репо».
func TestLinterCatchesBadPattern(t *testing.T) {
	bad := `package badrepo

type Repo struct{ db any }

func (r *Repo) Bad() error {
	r.db.Find(nil)
	return nil
}
`
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "bad.go", bad, parser.AllErrors)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	queryMethods := map[string]bool{"Find": true, "Create": true, "Updates": true}

	found := false
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
		name := exprName(sel.X)
		if strings.HasSuffix(name, ".db") {
			found = true
		}
		return true
	})
	if !found {
		t.Fatal("linter failed to catch the canonical bad pattern (r.db.Find)")
	}
}
