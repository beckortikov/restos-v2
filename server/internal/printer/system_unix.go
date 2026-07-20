//go:build !windows

package printer

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
)

// Печать через CUPS (macOS и Linux). `-o raw` = отдать файл в порт без
// фильтров и рендеринга, ровно как datatype="RAW" на Windows.
//
// Нужен ли CUPS вообще на кассе: боевые кассы у нас Windows, но dev-машина
// разработчика — macOS, и без этой ветки USB-принтер нельзя ни отладить, ни
// протестировать вне Windows.

// sendToSystemQueue отдаёт payload команде `lp` через stdin.
// exec.CommandContext сам убьёт процесс по ctx — отдельная обвязка не нужна.
func sendToSystemQueue(ctx context.Context, queue string, payload []byte) error {
	lp, err := exec.LookPath("lp")
	if err != nil {
		return fmt.Errorf("system printer %q: `lp` not found (CUPS not installed): %w", queue, err)
	}
	cmd := exec.CommandContext(ctx, lp, "-d", queue, "-o", "raw")
	cmd.Stdin = bytes.NewReader(payload)
	cmd.Env = append(cmd.Environ(), "LC_ALL=C")

	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return fmt.Errorf("system printer %q: lp: %s: %w", queue, msg, err)
		}
		return fmt.Errorf("system printer %q: lp: %w", queue, err)
	}
	return nil
}

// listSystemQueues парсит `lpstat -p -d`.
//
// Формат (LC_ALL=C, иначе на локализованной ОС ключевые слова уедут):
//
//	printer POS-80 is idle.  enabled since Mon 20 Jul 2026 10:00:00
//	system default destination: POS-80
//
// Пустой список — валидный ответ (принтеры в ОС не заведены), поэтому ошибку
// возвращаем только если самого lpstat нет. `lpstat -p` без принтеров на части
// систем выходит с ненулевым кодом — это не повод падать.
func listSystemQueues(ctx context.Context) ([]SystemQueue, error) {
	lpstat, err := exec.LookPath("lpstat")
	if err != nil {
		return nil, fmt.Errorf("`lpstat` not found (CUPS not installed): %w", err)
	}
	cmd := exec.CommandContext(ctx, lpstat, "-p", "-d")
	cmd.Env = append(cmd.Environ(), "LC_ALL=C")

	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	_ = cmd.Run() // код возврата игнорируем осознанно, см. док выше

	return parseLpstat(stdout.String()), nil
}

const lpstatDefaultPrefix = "system default destination:"

func parseLpstat(out string) []SystemQueue {
	var queues []SystemQueue
	var def string

	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "printer "):
			fields := strings.Fields(line)
			if len(fields) < 2 {
				continue
			}
			queues = append(queues, SystemQueue{
				Name:   fields[1],
				Status: lpstatStatus(fields),
			})
		case strings.HasPrefix(line, lpstatDefaultPrefix):
			def = strings.TrimSpace(strings.TrimPrefix(line, lpstatDefaultPrefix))
		}
	}

	if def != "" {
		for i := range queues {
			if queues[i].Name == def {
				queues[i].IsDefault = true
			}
		}
	}
	if queues == nil {
		return []SystemQueue{}
	}
	return queues
}

// lpstatStatus достаёт слово после "is" из «printer NAME is idle.» → "idle".
func lpstatStatus(fields []string) string {
	for i := 2; i < len(fields)-1; i++ {
		if fields[i] == "is" {
			return strings.TrimSuffix(fields[i+1], ".")
		}
	}
	return ""
}
