package service

import "testing"

// TestPayoutKind — разбор вида выплаты, включая легаси-формат.
//
// До разделения категорий аванс писался как «Зарплата» с суффиксом «(аванс)»
// в имени контрагента. Если отчёт этого не учтёт, вся история до обновления
// схлопнется в зарплату и завысит её ровно на сумму выданных авансов.
func TestPayoutKind(t *testing.T) {
	cases := []struct {
		name         string
		category     string
		counterparty string
		want         string
	}{
		{"зарплата", CategorySalary, "Иван Повар", "salary"},
		{"аванс новой категорией", CategoryAdvance, "Иван Повар", "advance"},
		{"сервис-чардж", "Сервис", "Аня Официант", "service"},
		{"легаси-аванс", CategorySalary, "Иван Повар (аванс)", "advance"},
		{"легаси-аванс в верхнем регистре", CategorySalary, "Иван Повар (АВАНС)", "advance"},
		// Имя сотрудника может законно содержать слово «аванс» без скобки —
		// такую строку в аванс записывать нельзя.
		{"слово аванс без скобки не считается", CategorySalary, "Авансов Пётр", "salary"},
		{"неизвестная категория → зарплата", "Прочее", "Кто-то", "salary"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := payoutKind(c.category, c.counterparty); got != c.want {
				t.Fatalf("payoutKind(%q, %q) = %q, want %q", c.category, c.counterparty, got, c.want)
			}
		})
	}
}

// TestSalaryCategory — kind из запроса → категория проводки.
func TestSalaryCategory(t *testing.T) {
	advance := "advance"
	salary := "salary"
	other := "whatever"
	cases := []struct {
		name string
		kind *string
		want string
	}{
		{"nil → зарплата (старые клиенты)", nil, CategorySalary},
		{"salary", &salary, CategorySalary},
		{"advance", &advance, CategoryAdvance},
		{"мусор → зарплата", &other, CategorySalary},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := salaryCategory(c.kind); got != c.want {
				t.Fatalf("salaryCategory = %q, want %q", got, c.want)
			}
		})
	}
}
