package printer

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"
)

// Virtual — пишет каждый job в файл .escpos в указанной директории.
// Полезно для смотрин на staging без реального принтера.
//
// Имя файла: <timestamp>_<counter>.escpos
type Virtual struct {
	Dir     string
	counter atomic.Int64
}

func NewVirtual(dir string) *Virtual {
	return &Virtual{Dir: dir}
}

func (v *Virtual) Name() string { return "virtual:" + v.Dir }

func (v *Virtual) Send(ctx context.Context, payload []byte) error {
	if err := os.MkdirAll(v.Dir, 0o755); err != nil {
		return fmt.Errorf("virtual mkdir: %w", err)
	}
	id := v.counter.Add(1)
	name := fmt.Sprintf("%s_%04d.escpos", time.Now().UTC().Format("20060102_150405"), id)
	return os.WriteFile(filepath.Join(v.Dir, name), payload, 0o644)
}
