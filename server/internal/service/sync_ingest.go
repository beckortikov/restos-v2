package service

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// SyncService — приём дельт на ЦЕНТРАЛЬНОМ узле (Фаза 2 multi-branch, ADR-003).
// Филиалы пушат сюда неотправленные строки sync_log; центральный узел делает
// upsert по row_id (идемпотентно) в свою БД — она становится сводной по сети.
//
// ВАЖНО: ingest НЕ скоупится по ресторану центрального узла — он хранит данные
// ВСЕХ филиалов сети (в payload уже есть restaurant_id/account_id). Поэтому
// используем Raw + явный upsert (легитимный сетевой агрегатор, не утечка).
//
// Режим «только нужное»: применяем известные сущности (перемещения), остальные
// пропускаем (forward-compat: новый филиал может прислать то, что старый центр
// ещё не умеет).
type SyncService struct {
	r *repo.Repo
}

func NewSyncService(r *repo.Repo) *SyncService {
	return &SyncService{r: r}
}

// SyncEntry — одна дельта в батче ingest.
type SyncEntry struct {
	Entity  string          `json:"entity"`
	RowID   string          `json:"row_id"`
	Op      string          `json:"op"`
	Payload json.RawMessage `json:"payload"`
}

// IngestInput — body POST /api/v1/sync/ingest.
type IngestInput struct {
	Entries []SyncEntry `json:"entries"`
}

// IngestResult — сколько дельт применено/пропущено/отвергнуто.
type IngestResult struct {
	Applied int `json:"applied"`
	Skipped int `json:"skipped"`
	// Rejected — строки, которые филиал прислал ЗА ЧУЖОЙ ресторан (Фаза Г).
	// Отдельно от Skipped: Skipped — «эту сущность мы не умеем, ничего
	// страшного», Rejected — «пришло то, чего приходить не должно».
	Rejected int `json:"rejected,omitempty"`
}

// Ingest применяет батч UP-пушей на центральном узле — upsert по PK (центр
// зеркалит авторитетные данные филиала). Идемпотентно.
//
// callerBranchID — узел, опознанный по его персональному токену
// (middleware.SyncCallerID). Пусто = звонящий пришёл с общим секретом сети и
// неотличим от остальных: тогда проверка принадлежности не применяется —
// иначе сломались бы кассы, подключённые до Фазы Г. Как только филиал
// переподключится и получит свой токен, проверка для него включится сама.
func (s *SyncService) Ingest(ctx context.Context, in IngestInput, callerBranchID string) (*IngestResult, error) {
	return s.applyIngest(ctx, in, callerBranchID)
}

// ApplyPulled применяет DOWN-pull на филиале — insert-if-absent (НЕ перезаписывает).
// Критично: получатель — авторитет по статусу received своих входящих перемещений;
// pull не должен откатить локальный received обратно в sent (гонка до up-sync).
//
// branchRestaurantID — id этого филиала (для сетевого меню: мастер → menu_items
// с merge, наследуемое из мастера, локальные цена/стоп сохраняются).
func (s *SyncService) ApplyPulled(ctx context.Context, in IngestInput, branchRestaurantID string) (*IngestResult, error) {
	return s.apply(ctx, in, false, branchRestaurantID)
}

// applyIngest — up-push с проверкой принадлежности строк звонящему.
//
// До Фазы Г central принимал батч на веру: он знал лишь «пришёл кто-то с
// правильным секретом сети», а restaurant_id брал из самого payload. То есть
// любой узел мог писать данные ОТ ИМЕНИ соседнего — подделать выручку, расходы,
// остатки чужого филиала. Персональные токены дали имя звонящего, и теперь эта
// подстановка ловится. Ошибкой считаем строку, а не батч: одна чужая запись не
// повод отбросить сотню нормальных (и не повод загнать очередь филиала в
// карантин — см. Pusher).
func (s *SyncService) applyIngest(ctx context.Context, in IngestInput, callerBranchID string) (*IngestResult, error) {
	if callerBranchID == "" {
		return s.apply(ctx, in, true, "")
	}
	allowed := IngestInput{Entries: make([]SyncEntry, 0, len(in.Entries))}
	rejected := 0
	for _, e := range in.Entries {
		if entryBelongsTo(e, callerBranchID) {
			allowed.Entries = append(allowed.Entries, e)
			continue
		}
		rejected++
		log.Warn().
			Str("entity", e.Entity).Str("row_id", e.RowID).Str("caller", callerBranchID).
			Msg("sync ingest: отвергнута строка за чужой ресторан")
	}
	res, err := s.apply(ctx, allowed, true, "")
	if err != nil {
		return nil, err
	}
	res.Rejected = rejected
	return res, nil
}

// entryBelongsTo — вправе ли узел branchID присылать эту строку.
//
// Разбираем payload по трём полям, потому что «принадлежность» у сущностей
// разная:
//   - restaurant_id — обычные пер-ресторанные таблицы (заказы, склад, деньги…);
//   - from/to_restaurant_id — перемещения и переводы: их пушат ОБЕ стороны
//     (отправитель при создании, получатель при приёме), поэтому годится любая;
//   - ни одного из них — account-level сущности (nomenclature): своего
//     ресторана у них нет, проверять нечего.
func entryBelongsTo(e SyncEntry, branchID string) bool {
	var p struct {
		RestaurantID     *string `json:"restaurant_id"`
		FromRestaurantID *string `json:"from_restaurant_id"`
		ToRestaurantID   *string `json:"to_restaurant_id"`
	}
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		// Нечитаемый payload отвергать здесь не нужно: он всё равно упадёт в
		// своём apply* с внятной ошибкой валидации.
		return true
	}
	if p.FromRestaurantID != nil || p.ToRestaurantID != nil {
		return (p.FromRestaurantID != nil && *p.FromRestaurantID == branchID) ||
			(p.ToRestaurantID != nil && *p.ToRestaurantID == branchID)
	}
	if p.RestaurantID == nil || *p.RestaurantID == "" {
		return true // account-level или строка без привязки — не наше дело
	}
	return *p.RestaurantID == branchID
}

func (s *SyncService) apply(ctx context.Context, in IngestInput, updateAll bool, branchID string) (*IngestResult, error) {
	res := &IngestResult{}
	for _, e := range in.Entries {
		switch e.Entity {
		case "stock_transfers":
			if err := s.applyTransfer(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "money_transfers":
			if err := s.applyMoneyTransfer(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "financial_operations":
			if err := s.applyFinancialOp(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "orders":
			if err := s.applyOrder(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "cash_shifts":
			if err := s.applyShift(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "cash_shift_operations":
			if err := s.applyShiftOp(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "users":
			if err := s.applyUser(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "menu_items":
			if err := s.applyMenuItem(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "tables":
			if err := s.applyTable(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "zones":
			if err := s.applyZone(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "ingredients":
			if err := s.applyIngredient(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "stock_movements":
			if err := s.applyStockMovement(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "stock_receipts":
			if err := s.applyStockReceipt(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "stock_writeoffs":
			if err := s.applyStockWriteoff(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "inventory_checks":
			if err := s.applyInventoryCheck(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "stock_returns":
			if err := s.applyStockReturn(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "suppliers":
			if err := s.applySupplier(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "supply_expenses":
			if err := s.applySupplyExpense(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "financial_accounts":
			if err := s.applyFinancialAccount(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "recurring_payments":
			if err := s.applyRecurringPayment(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "time_entries":
			if err := s.applyTimeEntry(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "salary_worked_days":
			if err := s.applySalaryWorkedDay(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "salary_day_multipliers":
			if err := s.applySalaryDayMultiplier(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "salary_deductions":
			if err := s.applySalaryDeduction(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "salary_advances":
			if err := s.applySalaryAdvance(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "network_menu_items":
			if branchID == "" {
				res.Skipped++ // мастер-меню применяется только при down-pull на филиале
				continue
			}
			if err := s.applyNetworkMenu(ctx, e, branchID); err != nil {
				return nil, err
			}
			res.Applied++
		case "nomenclature":
			if err := s.applyNomenclature(ctx, e, branchID); err != nil {
				return nil, err
			}
			res.Applied++
		case "restaurants":
			if branchID == "" {
				res.Skipped++ // только down-pull на филиале — central сам заводит соседей через RedeemInvite, не через этот путь
				continue
			}
			if err := s.applyRestaurantStub(ctx, e); err != nil {
				return nil, err
			}
			res.Applied++
		default:
			res.Skipped++ // неизвестная сущность — не роняем весь батч
		}
	}
	return res, nil
}

// applyNetworkMenu — распространение мастер-блюда сети в меню филиала (ADR-004).
// Наследуемые поля (name/category/station/unit) берём из мастера; локальные
// (price/is_available/emoji) НЕ трогаем — ИСКЛЮЧЕНИЕ ровно одно: available
// мастера задаёт СТАРТОВОЕ значение при первом создании копии (дальше её
// переключает сам филиал, мастер больше не вмешивается). Нет локального
// блюда с этим master_id → создаём. Есть → обновляем только наследуемое.
//
// deleted_at мастера (владелец удалил блюдо сети с центра) обрабатывается
// ДО создания/обновления — тот же tombstone-приём, что у nomenclature: сносим
// локальную копию, если она есть, и не создаём новую, если её ещё не было.
func (s *SyncService) applyNetworkMenu(ctx context.Context, e SyncEntry, branchID string) error {
	var m models.NetworkMenuItem
	if err := json.Unmarshal(e.Payload, &m); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid network_menu_items payload", err)
	}
	if m.ID == "" {
		return apperrors.Wrap("VALIDATION", "network_menu_items payload missing id", nil)
	}
	if m.DeletedAt != nil {
		return s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
			var local models.MenuItem
			err := tx.Where("restaurant_id = ? AND master_id = ?", branchID, m.ID).First(&local).Error
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil // никогда не материализовалось на этом филиале — нечего сносить
			}
			if err != nil {
				return err
			}
			// Продукт + его варианты — тот же охват, что у обычного SoftDeleteItem.
			var ids []string
			if err := tx.Model(&models.MenuItem{}).
				Where("id = ? OR parent_id = ?", local.ID, local.ID).
				Pluck("id", &ids).Error; err != nil {
				return err
			}
			if err := tx.Model(&models.MenuItem{}).Where("id = ? OR parent_id = ?", local.ID, local.ID).
				Updates(map[string]any{"is_deleted": true, "updated_at": time.Now().UTC()}).Error; err != nil {
				return err
			}
			return recordMenuItemsSync(tx, ids)
		})
	}
	var localProductID string
	txErr := s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		var existing models.MenuItem
		err := tx.Where("restaurant_id = ? AND master_id = ?", branchID, m.ID).First(&existing).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			avail := m.Available
			item := &models.MenuItem{
				ID: uuid.NewString(), MasterID: &m.ID, RestaurantID: &branchID,
				Name: &m.Name, Category: m.Category, Price: m.BasePrice,
				Station: m.Station, Unit: m.Unit, Emoji: m.Emoji, IsAvailable: &avail,
			}
			if err := tx.Create(item).Error; err != nil {
				return err
			}
			localProductID = item.ID
			// Унаследованный от мастера товар — тоже часть меню ЭТОГО филиала:
			// пишем в sync_log филиала, чтобы обычный Pusher отправил его
			// central обратно (иначе central никогда не увидит товары сети в
			// branch-view меню конкретного филиала — только на филиале локально).
			return recordMenuItemsSync(tx, []string{item.ID})
		}
		if err != nil {
			return err
		}
		localProductID = existing.ID
		// Есть ли РЕАЛЬНОЕ изменение наследуемых полей? applyNetworkMenu вызывается
		// на КАЖДЫЙ down-pull (раз в --sync-interval-sec, т.е. постоянно, а не
		// только когда мастер реально поменялся) — без этой проверки
		// recordMenuItemsSync писал бы дельту каждый цикл ДАЖЕ без изменений,
		// а поскольку сама запись в sync_log тоже реплицируется на central —
		// получался бы бесконечный поток "изменений" туда-обратно (найдено
		// вживую на двухузловом стенде: одна и та же строка синкалась каждые
		// 5 секунд без остановки).
		if (existing.Name == nil || *existing.Name != m.Name) ||
			!strPtrEqual(existing.Category, m.Category) ||
			!strPtrEqual(existing.Station, m.Station) ||
			!strPtrEqual(existing.Unit, m.Unit) {
			if err := tx.Model(&models.MenuItem{}).Where("id = ?", existing.ID).
				Updates(map[string]any{
					"name": m.Name, "category": m.Category, "station": m.Station, "unit": m.Unit,
				}).Error; err != nil {
				return err
			}
			return recordMenuItemsSync(tx, []string{existing.ID})
		}
		return nil
	})
	if txErr != nil {
		return txErr
	}
	if err := s.applyNetworkMenuAttributes(ctx, branchID, localProductID, &m); err != nil {
		return err
	}
	return s.applyNetworkMenuTechCards(ctx, branchID, localProductID, &m)
}

// applyNetworkMenuAttributes — вариации мастера на филиале (миграция 084).
// Пустое attributes у мастера означает «мастер вариациями не управляет», а не
// «снять вариации»: у всех мастеров, заведённых до 082, поле NULL, и снятие
// уничтожило бы вариации, которые филиал завёл сам.
//
// Повторный pull приходит каждый тик — от бесконечного пересинка (и потока
// пустых дельт в sync_log, см. головной коммент applyNetworkMenu) защищает
// сравнение канонической сигнатуры: атрибуты+значения+цены комбинаций мастера
// против фактического состояния продукта. Совпало — выходим без записи.
//
// Применение — через MenuService.SyncAttributes с подменённым tenant: та же
// логика диффа/генерации вариантов, что и у локальной формы (вторая
// реализация неизбежно разошлась бы). Хуки при этом ВКЛЮЧЕНЫ — созданные
// варианты уезжают на central обычным пушем, как и сам материализованный
// продукт.
func (s *SyncService) applyNetworkMenuAttributes(ctx context.Context, branchID, productID string, m *models.NetworkMenuItem) error {
	if productID == "" || len(m.Attributes) == 0 || string(m.Attributes) == "null" {
		return nil
	}
	var attrs NetworkMenuAttrs
	if err := json.Unmarshal(m.Attributes, &attrs); err != nil || len(attrs.Attributes) == 0 {
		return nil // битый/пустой снапшот мастера не должен ронять весь pull
	}

	tctx := tenant.WithRestaurant(ctx, branchID)
	menuSvc := NewMenuService(s.r)
	state, err := menuSvc.GetAttributes(tctx, productID)
	if err != nil {
		return err
	}
	if localAttrsSignature(state) == masterAttrsSignature(&attrs) {
		return nil
	}

	in := SyncAttributesInput{}
	for _, a := range attrs.Attributes {
		ai := MenuAttributeInput{Name: a.Name}
		scaleID := ""
		if a.Scale {
			scaleID, err = s.ensureSizeScale(ctx, branchID, a.Name, a.Values)
			if err != nil {
				return err
			}
		}
		if scaleID != "" {
			ai.SizeScaleID = &scaleID
		} else {
			for _, v := range a.Values {
				ai.Values = append(ai.Values, MenuAttributeValueInput{Label: v})
			}
		}
		in.Attributes = append(in.Attributes, ai)
	}
	for i := range attrs.Combos {
		price := attrs.Combos[i].Price
		in.Combos = append(in.Combos, ComboPriceInput{Labels: attrs.Combos[i].Labels, Price: &price})
	}
	_, err = menuSvc.SyncAttributes(tctx, productID, in)
	return err
}

// ensureSizeScale — локальная шкала размеров для scale-атрибута мастера:
// ищем по имени (без регистра); совпадающую по НАБОРУ значений — используем,
// отличающуюся — не трогаем (вернём "" → атрибут получит свободные значения:
// scale-linked атрибут зеркалит ВСЕ значения шкалы, и чужая расширенная шкала
// породила бы варианты без цен — SyncAttributes падает ровно на этом). Нет
// вовсе — создаём по значениям мастера.
func (s *SyncService) ensureSizeScale(ctx context.Context, rid, name string, labels []string) (string, error) {
	db := s.r.Raw().WithContext(ctx)
	want := map[string]bool{}
	for _, l := range labels {
		want[strings.ToLower(strings.TrimSpace(l))] = true
	}

	var scales []models.SizeScale
	if err := db.Where("restaurant_id = ? AND LOWER(name) = LOWER(?)", rid, strings.TrimSpace(name)).
		Find(&scales).Error; err != nil {
		return "", err
	}
	for i := range scales {
		var vals []models.SizeScaleValue
		if err := db.Where("size_scale_id = ?", scales[i].ID).Find(&vals).Error; err != nil {
			return "", err
		}
		if len(vals) != len(want) {
			continue
		}
		match := true
		for _, v := range vals {
			label := v.Code
			if v.Title != nil && *v.Title != "" {
				label = *v.Title
			}
			if !want[strings.ToLower(strings.TrimSpace(label))] {
				match = false
				break
			}
		}
		if match {
			return scales[i].ID, nil
		}
	}
	if len(scales) > 0 {
		return "", nil // шкала с этим именем есть, но другая — не вмешиваемся
	}

	now := time.Now().UTC()
	scale := models.SizeScale{ID: uuid.NewString(), Name: strings.TrimSpace(name), RestaurantID: &rid, CreatedAt: now, UpdatedAt: now}
	if err := db.Session(&gorm.Session{SkipHooks: true}).Create(&scale).Error; err != nil {
		return "", err
	}
	for i, l := range labels {
		v := models.SizeScaleValue{
			ID: uuid.NewString(), SizeScaleID: scale.ID, Code: strings.TrimSpace(l),
			SortOrder: i, RestaurantID: &rid, CreatedAt: now, UpdatedAt: now,
		}
		if err := db.Session(&gorm.Session{SkipHooks: true}).Create(&v).Error; err != nil {
			return "", err
		}
	}
	return scale.ID, nil
}

// masterAttrsSignature / localAttrsSignature — каноническая форма «атрибуты+
// значения+цены комбинаций» для сравнения мастера с фактическим состоянием
// продукта. Цены нормализуются decimal'ом («25» == «25.00»), комбинации
// сортируются по ключу лейблов. Привязка к шкале в сигнатуру сознательно НЕ
// входит: она best-effort (чужую шкалу не трогаем) и не должна вызывать
// пересинк каждый тик, когда всё остальное совпадает.
func masterAttrsSignature(a *NetworkMenuAttrs) string {
	var b strings.Builder
	for _, attr := range a.Attributes {
		b.WriteString("a:" + strings.TrimSpace(attr.Name) + "=")
		for _, v := range attr.Values {
			b.WriteString(strings.TrimSpace(v) + ",")
		}
		b.WriteString(";")
	}
	combos := make([]string, 0, len(a.Combos))
	for _, c := range a.Combos {
		price := c.Price
		if d, err := decimal.FromString(c.Price); err == nil {
			price = decimal.Normalize(d).String()
		}
		combos = append(combos, comboLabelKey(c.Labels)+"="+price)
	}
	sort.Strings(combos)
	return b.String() + "|" + strings.Join(combos, ";")
}

func localAttrsSignature(state *ProductAttributesState) string {
	labelByValID := map[string]struct {
		attrIdx int
		label   string
	}{}
	var b strings.Builder
	for ai, attr := range state.Attributes {
		b.WriteString("a:" + strings.TrimSpace(attr.Name) + "=")
		for _, v := range attr.Values {
			b.WriteString(strings.TrimSpace(v.Label) + ",")
			labelByValID[v.ID] = struct {
				attrIdx int
				label   string
			}{ai, v.Label}
		}
		b.WriteString(";")
	}
	combos := make([]string, 0, len(state.Variants))
	for _, v := range state.Variants {
		labels := make([]string, len(state.Attributes))
		for _, vid := range v.ValueIDs {
			if info, ok := labelByValID[vid]; ok && info.attrIdx < len(labels) {
				labels[info.attrIdx] = info.label
			}
		}
		combos = append(combos, comboLabelKey(labels)+"="+decimal.Normalize(v.Price).String())
	}
	sort.Strings(combos)
	return b.String() + "|" + strings.Join(combos, ";")
}

// applyNomenclature — распространение общего каталога номенклатуры сети на
// филиал (ADR-003 вариант 3B). В отличие от applyNetworkMenu, строка сети И
// строка филиала — ОДНА и та же запись (тот же id: ingredients.nomenclature_id
// ссылается на него одинаково на любом узле) — обычный upsert по id, без
// производной локальной копии.
//
// Фаза М — авто-материализация: следом заводим у филиала сам ТОВАР с нулевым
// остатком. Без этого запись в каталоге сети оставалась чистой абстракцией:
// владелец создавал продукт в центре, на складах филиалов не менялось ничего,
// и товар появлялся там только после первого перемещения. Ожидание владельца
// («создал в центре → есть у всех») теперь выполняется буквально.
//
// Если у филиала уже есть свой товар с тем же именем и единицей — он
// СВЯЗЫВАЕТСЯ с номенклатурой, а не дублируется (см. ensureNomenclatureIngredient).
//
// Направление ОБА (Фаза Г): вниз — распространение каталога, вверх — запись,
// которую завёл филиал (руками или автоматически при первой отправке товара).
// branchID == "" означает приём на central: там только пишем строку каталога,
// без материализации товара — у central свой склад и своя номенклатура ему
// материализуется в CreateNomenclature, а заводить у себя товары всех филиалов
// он не должен.
func (s *SyncService) applyNomenclature(ctx context.Context, e SyncEntry, branchID string) error {
	var n models.Nomenclature
	if err := json.Unmarshal(e.Payload, &n); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid nomenclature payload", err)
	}
	if n.ID == "" {
		return apperrors.Wrap("VALIDATION", "nomenclature payload missing id", nil)
	}
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		if err := tx.Clauses(onConflict(true)).Create(&n).Error; err != nil {
			return err
		}

		// Tombstone (Фаза Г): запись убрали из каталога сети. ОТВЯЗЫВАЕМ свой
		// товар, но НЕ удаляем — у него остаток и вся история движений, и
		// уборка справочника не повод их уничтожать. Идемпотентно: второй
		// проход не найдёт привязанных и ничего не сделает.
		if n.DeletedAt != nil {
			var ids []string
			if err := tx.Model(&models.Ingredient{}).
				Where("nomenclature_id = ?", n.ID).Pluck("id", &ids).Error; err != nil {
				return err
			}
			if len(ids) == 0 {
				return nil
			}
			if err := tx.Model(&models.Ingredient{}).Where("id IN ?", ids).
				Update("nomenclature_id", nil).Error; err != nil {
				return err
			}
			// Снимок наверх: central должен узнать, что товар больше не
			// привязан, иначе у него останется висеть ссылка на удалённую
			// запись. На central этот путь no-op (синк там выключен).
			return recordIngredientSync(tx, ids)
		}

		if branchID == "" {
			return nil // приём на central: только запись каталога, без товара
		}
		name := n.Name
		_, err := ensureNomenclatureIngredient(tx, branchID, ensureIngredientInput{
			NomenclatureID: &n.ID,
			Name:           &name,
			Unit:           n.Unit,
			PricePerUnit:   decimal.Zero, // цену задаст первая приёмка/перемещение
			Now:            time.Now().UTC(),
		})
		return err
	})
}

// applyRestaurantStub — заводит/обновляет НА ФИЛИАЛЕ заглушку-строку соседа
// по сети (central или другой филиал) — только для cross-node ссылок
// (to_restaurant_id в перемещениях, ListBranches-дропдаун), НЕ реальные
// бизнес-данные соседа. Явный список колонок (не UpdateAll) — у Restaurant
// десятки полей (license_key/license_expires_at/settings и т.д.), которых в
// этом зеркале нет и заведомо не будет; UpdateAll затёр бы их NULL при
// каждом pull, если бы id когда-нибудь совпал с чем-то настоящим.
func (s *SyncService) applyRestaurantStub(ctx context.Context, e SyncEntry) error {
	var r models.Restaurant
	if err := json.Unmarshal(e.Payload, &r); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid restaurants payload", err)
	}
	if r.ID == "" {
		return apperrors.Wrap("VALIDATION", "restaurants payload missing id", nil)
	}
	stub := models.Restaurant{ID: r.ID, Name: r.Name, AccountID: r.AccountID, Kind: r.Kind}
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		// Select — иначе Create() шлёт INSERT со ВСЕМИ полями модели (Currency/
		// ServicePercent/... на zero-value); default-теги GORM для указателей
		// омитит не всегда надёжно (см. gorm-zero-value-default-tag-gotcha).
		// Явный список колонок — и для insert, и для conflict-update — снимает
		// вопрос целиком.
		return tx.Select("id", "name", "account_id", "kind").Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "id"}},
			DoUpdates: clause.AssignmentColumns([]string{"name", "account_id", "kind"}),
		}).Create(&stub).Error
	})
}

// onConflict — UpdateAll (upsert) или DoNothing (insert-if-absent) по id.
func onConflict(updateAll bool) clause.OnConflict {
	c := clause.OnConflict{Columns: []clause.Column{{Name: "id"}}}
	if updateAll {
		c.UpdateAll = true
	} else {
		c.DoNothing = true
	}
	return c
}

// applyStatusEcho — ЕДИНСТВЕННОЕ обновление, разрешённое поверх
// insert-if-absent при down-pull на филиале (Фаза Д2): перевод статуса
// sent → received у документа, который филиал ОТПРАВИЛ.
//
// Зачем: получатель принимает документ у себя и пушит новый статус на central,
// но обратно отправителю central его не отдавал никогда — PullFor выбирал
// только доки, адресованные текущему узлу. У отправителя документ навсегда
// оставался «отправлено», хотя товар/деньги давно приняты (баг виден в 2 из 3
// топологий: филиал→central и филиал→филиал; central→филиал работал случайно,
// потому что там central обновляется прямым пушем получателя).
//
// Почему это не ломает insert-if-absent, ради которого pull вообще не
// перезатирает локальные строки: переход разрешён РОВНО ОДИН, вперёд, и
// зашит в WHERE status='sent'. Отсюда сразу три свойства:
//   - откатить локальный received обратно в sent невозможно (гонка «central
//     ещё sent, филиал уже received» — исходная причина insert-if-absent);
//   - идемпотентность: второй pull того же received матчит 0 строк;
//   - нет бесконечного цикла репликации (см. sync-replication-infinite-loop):
//     запись происходит только когда статус РЕАЛЬНО меняется, а сравнение
//     атомарно в самом UPDATE, а не read-then-compare.
//
// to_account_id получателя намеренно НЕ эхуем: это UUID из ЕГО БД, на стороне
// отправителя он не резолвится ни во что осмысленное.
func applyStatusEcho(tx *gorm.DB, table, rowID, status string, receivedAt *time.Time, receivedBy *string) error {
	if status != "received" || rowID == "" {
		return nil
	}
	return tx.Table(table).
		Where("id = ? AND status = ?", rowID, "sent").
		Updates(map[string]any{
			"status":      "received",
			"received_at": receivedAt,
			"received_by": receivedBy,
			"updated_at":  time.Now().UTC(),
		}).Error
}

// applyTransfer — upsert перемещения + его строк из payload. На центральном
// узле это лишь запись документа (для сводки/доставки получателю); движения
// остатка НЕ выполняются — их сделает получатель при Receive у себя.
func (s *SyncService) applyTransfer(ctx context.Context, e SyncEntry, updateAll bool) error {
	var t models.StockTransfer
	if err := json.Unmarshal(e.Payload, &t); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid stock_transfers payload", err)
	}
	if t.ID == "" {
		return apperrors.Wrap("VALIDATION", "stock_transfers payload missing id", nil)
	}
	lines := t.Lines
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		// SkipHooks: реплицированные данные не аудируем и не рекордим повторно.
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		// upsert/insert самого перемещения (без ассоциаций).
		if err := tx.Omit("Lines").Clauses(conflict).Create(&t).Error; err != nil {
			return err
		}
		// строки.
		for i := range lines {
			l := lines[i]
			if err := tx.Clauses(conflict).Create(&l).Error; err != nil {
				return err
			}
		}
		if !updateAll {
			// Филиал: единственный разрешённый апдейт — эхо приёма отправителю.
			return applyStatusEcho(tx, "stock_transfers", t.ID, t.Status, t.ReceivedAt, t.ReceivedBy)
		}
		return nil
	})
}

// applyMoneyTransfer — то же для денежного перевода (Фаза Д). Только запись
// документа: балансы счетов НЕ трогаются ни на одной стороне — списание уже
// сделал отправитель у себя (Create), зачисление сделает получатель, когда
// нажмёт «принять» (Receive). Иначе деньги удвоились бы на каждом pull.
func (s *SyncService) applyMoneyTransfer(ctx context.Context, e SyncEntry, updateAll bool) error {
	var t models.MoneyTransfer
	if err := json.Unmarshal(e.Payload, &t); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid money_transfers payload", err)
	}
	if t.ID == "" {
		return apperrors.Wrap("VALIDATION", "money_transfers payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		if err := tx.Clauses(conflict).Create(&t).Error; err != nil {
			return err
		}
		if !updateAll {
			return applyStatusEcho(tx, "money_transfers", t.ID, t.Status, t.ReceivedAt, t.ReceivedBy)
		}
		return nil
	})
}

// applyOrder — upsert заказа + его позиций из payload (ADR-003 Фаза 5).
// Central получает точную копию терминального снимка заказа филиала
// (closed/cancelled/refunded); это голый upsert двух таблиц, а не вызов
// OrdersService — списание склада и создание financial_operations здесь
// НЕ выполняются повторно (у Order/OrderItem нет GORM-хуков, только
// императивный код внутри Close()/Cancel()/Refund() на филиале).
func (s *SyncService) applyOrder(ctx context.Context, e SyncEntry, updateAll bool) error {
	var p orderSyncPayload
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid orders payload", err)
	}
	if p.ID == "" {
		return apperrors.Wrap("VALIDATION", "orders payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		if err := tx.Clauses(conflict).Create(&p.Order).Error; err != nil {
			return err
		}
		for i := range p.Items {
			if err := tx.Clauses(conflict).Create(&p.Items[i]).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// applyShift — upsert кассовой смены из payload (ADR-003 «Central видит всё»,
// Ф1). В отличие от заказов, синкается на КАЖДОЕ сохранение (см.
// recordShiftSync) — central должен видеть агрегаты ещё открытой смены.
func (s *SyncService) applyShift(ctx context.Context, e SyncEntry, updateAll bool) error {
	var sh models.CashShift
	if err := json.Unmarshal(e.Payload, &sh); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid cash_shifts payload", err)
	}
	if sh.ID == "" {
		return apperrors.Wrap("VALIDATION", "cash_shifts payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&sh).Error
	})
}

// applyShiftOp — upsert/delete операции смены. INSERT приходит через
// generic-хук (trackedInsert), DELETE — явно из recordShiftOpDeleteSync
// (DeleteExpense/DeleteOperation на филиале); такой payload пуст, удаляем
// строго по RowID.
func (s *SyncService) applyShiftOp(ctx context.Context, e SyncEntry, updateAll bool) error {
	if e.Op == "delete" {
		if e.RowID == "" {
			return apperrors.Wrap("VALIDATION", "cash_shift_operations delete missing row_id", nil)
		}
		return s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
			return tx.Where("id = ?", e.RowID).Delete(&models.CashShiftOperation{}).Error
		})
	}
	var op models.CashShiftOperation
	if err := json.Unmarshal(e.Payload, &op); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid cash_shift_operations payload", err)
	}
	if op.ID == "" {
		return apperrors.Wrap("VALIDATION", "cash_shift_operations payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&op).Error
	})
}

// applyUser — upsert сотрудника из payload. PIN/Password несут json:"-" на
// models.User — payload их не содержит вовсе, поэтому реплицированная строка
// на central всегда с pin/password = NULL. LoginByPIN фильтрует
// "pin IS NOT NULL" (см. auth.go) — реплицированный сотрудник филиала физически
// не может залогиниться на central.
func (s *SyncService) applyUser(ctx context.Context, e SyncEntry, updateAll bool) error {
	var u models.User
	if err := json.Unmarshal(e.Payload, &u); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid users payload", err)
	}
	if u.ID == "" {
		return apperrors.Wrap("VALIDATION", "users payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&u).Error
	})
}

// applyMenuItem — upsert блюда меню (снапшот, Ф2). Delete отдельно не
// нужен — удаление на филиале всегда soft (is_deleted=true уже в payload,
// см. recordMenuItemsSync/SoftDeleteItem), обычный upsert его переносит.
func (s *SyncService) applyMenuItem(ctx context.Context, e SyncEntry, updateAll bool) error {
	var mi models.MenuItem
	if err := json.Unmarshal(e.Payload, &mi); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid menu_items payload", err)
	}
	if mi.ID == "" {
		return apperrors.Wrap("VALIDATION", "menu_items payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&mi).Error
	})
}

// applyTable — upsert/delete стола (Ф2). Delete — НАСТОЯЩИЙ (в отличие от
// menu_items): TablesWriteService.Delete делает hard DELETE, не soft.
func (s *SyncService) applyTable(ctx context.Context, e SyncEntry, updateAll bool) error {
	if e.Op == "delete" {
		if e.RowID == "" {
			return apperrors.Wrap("VALIDATION", "tables delete missing row_id", nil)
		}
		return s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
			return tx.Where("id = ?", e.RowID).Delete(&models.Table{}).Error
		})
	}
	var t models.Table
	if err := json.Unmarshal(e.Payload, &t); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid tables payload", err)
	}
	if t.ID == "" {
		return apperrors.Wrap("VALIDATION", "tables payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&t).Error
	})
}

// applyZone — upsert/delete зоны (Ф2). Delete — настоящий, как у tables.
func (s *SyncService) applyZone(ctx context.Context, e SyncEntry, updateAll bool) error {
	if e.Op == "delete" {
		if e.RowID == "" {
			return apperrors.Wrap("VALIDATION", "zones delete missing row_id", nil)
		}
		return s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
			return tx.Where("id = ?", e.RowID).Delete(&models.Zone{}).Error
		})
	}
	var z models.Zone
	if err := json.Unmarshal(e.Payload, &z); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid zones payload", err)
	}
	if z.ID == "" {
		return apperrors.Wrap("VALIDATION", "zones payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&z).Error
	})
}

// applyIngredient — upsert снапшота ингредиента (Ф3). Delete — настоящий
// (IngredientsWriteService.Delete/removeParentPhantomBacking), как у tables/
// zones. SkipHooks здесь избыточен для самой модели Ingredient (она не в
// trackedInsert), но консистентен с остальными apply*-функциями.
func (s *SyncService) applyIngredient(ctx context.Context, e SyncEntry, updateAll bool) error {
	if e.Op == "delete" {
		if e.RowID == "" {
			return apperrors.Wrap("VALIDATION", "ingredients delete missing row_id", nil)
		}
		return s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
			return tx.Where("id = ?", e.RowID).Delete(&models.Ingredient{}).Error
		})
	}
	var ing models.Ingredient
	if err := json.Unmarshal(e.Payload, &ing); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid ingredients payload", err)
	}
	if ing.ID == "" {
		return apperrors.Wrap("VALIDATION", "ingredients payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&ing).Error
	})
}

// applyStockMovement — upsert append-only события движения (Ф3). SkipHooks
// КРИТИЧЕН здесь: stockAfterCreate (audit/stock_hook.go) проверяет
// tx.Statement.SkipHooks первой строкой и отказывается от повторной
// денормализации ingredients.qty — central получает уже денормализованный
// снапшот отдельно (applyIngredient), «проигрывание» движения задвоило бы
// delta. Delete не нужен — движения не удаляются (append-only источник истины).
func (s *SyncService) applyStockMovement(ctx context.Context, e SyncEntry, updateAll bool) error {
	var mv models.StockMovement
	if err := json.Unmarshal(e.Payload, &mv); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid stock_movements payload", err)
	}
	if mv.ID == "" {
		return apperrors.Wrap("VALIDATION", "stock_movements payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&mv).Error
	})
}

// applyStockReceipt — upsert накладной приёмки + её строк (Ф4). Строки
// insert-only (см. разведку sync_docs.go) — upsert безопасен и на повторе.
func (s *SyncService) applyStockReceipt(ctx context.Context, e SyncEntry, updateAll bool) error {
	var p receiptSyncPayload
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid stock_receipts payload", err)
	}
	if p.ID == "" {
		return apperrors.Wrap("VALIDATION", "stock_receipts payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		if err := tx.Clauses(conflict).Create(&p.StockReceipt).Error; err != nil {
			return err
		}
		for i := range p.Lines {
			if err := tx.Clauses(conflict).Create(&p.Lines[i]).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// applyStockWriteoff — upsert списания + его строк (Ф4).
func (s *SyncService) applyStockWriteoff(ctx context.Context, e SyncEntry, updateAll bool) error {
	var p writeoffSyncPayload
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid stock_writeoffs payload", err)
	}
	if p.ID == "" {
		return apperrors.Wrap("VALIDATION", "stock_writeoffs payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		if err := tx.Clauses(conflict).Create(&p.StockWriteoff).Error; err != nil {
			return err
		}
		for i := range p.Lines {
			if err := tx.Clauses(conflict).Create(&p.Lines[i]).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// applyInventoryCheck — upsert инвентаризации + её строк (Ф4). Приходит
// дважды за жизненный цикл документа (Create=draft, Apply=applied) — upsert
// второй раз просто перезаписывает шапку тем же id, строки не меняются.
func (s *SyncService) applyInventoryCheck(ctx context.Context, e SyncEntry, updateAll bool) error {
	var p inventorySyncPayload
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid inventory_checks payload", err)
	}
	if p.ID == "" {
		return apperrors.Wrap("VALIDATION", "inventory_checks payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		if err := tx.Clauses(conflict).Create(&p.InventoryCheck).Error; err != nil {
			return err
		}
		for i := range p.Lines {
			if err := tx.Clauses(conflict).Create(&p.Lines[i]).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// applyStockReturn — upsert возврата поставщику + его строк (Ф4). Приходит
// дважды (CreateReturn, CancelReturn) — второй раз только шапка меняется
// (cancelled_at/cancelled_by), строки те же (перечитаны заново, содержимое
// идентично).
func (s *SyncService) applyStockReturn(ctx context.Context, e SyncEntry, updateAll bool) error {
	var p returnSyncPayload
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid stock_returns payload", err)
	}
	if p.ID == "" {
		return apperrors.Wrap("VALIDATION", "stock_returns payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		if err := tx.Clauses(conflict).Create(&p.StockReturn).Error; err != nil {
			return err
		}
		for i := range p.Lines {
			if err := tx.Clauses(conflict).Create(&p.Lines[i]).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// applySupplier — upsert/delete снапшота поставщика (Ф4). Delete — настоящий
// (SuppliersService.Delete делает hard DELETE), как у tables/zones/ingredients.
func (s *SyncService) applySupplier(ctx context.Context, e SyncEntry, updateAll bool) error {
	if e.Op == "delete" {
		if e.RowID == "" {
			return apperrors.Wrap("VALIDATION", "suppliers delete missing row_id", nil)
		}
		return s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
			return tx.Where("id = ?", e.RowID).Delete(&models.Supplier{}).Error
		})
	}
	var sup models.Supplier
	if err := json.Unmarshal(e.Payload, &sup); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid suppliers payload", err)
	}
	if sup.ID == "" {
		return apperrors.Wrap("VALIDATION", "suppliers payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&sup).Error
	})
}

// applySupplyExpense — upsert append-only расхода снабжения (Ф4). Приходит
// через generic trackedInsert (recorder_hook.go), не explicit recordXSync —
// единственная точка создания (SupplyExpensesService.Create) никогда не
// обновляет/не удаляет строку. Delete не нужен.
func (s *SyncService) applySupplyExpense(ctx context.Context, e SyncEntry, updateAll bool) error {
	var se models.SupplyExpense
	if err := json.Unmarshal(e.Payload, &se); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid supply_expenses payload", err)
	}
	if se.ID == "" {
		return apperrors.Wrap("VALIDATION", "supply_expenses payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&se).Error
	})
}

// PullFor — сторона ЦЕНТРАЛЬНОГО узла: дельты, адресованные филиалу
// restaurantID (down-sync, ADR-003 Фаза 2). Пока — входящие перемещения в
// статусе sent (получатель ещё не принял). Возвращаем в формате ingest, чтобы
// филиал применил их своим же Ingest (upsert). Идемпотентно и без курсора:
// после приёма статус станет received и перестанет попадать в выборку.
// mirrorSince — курсор для зеркальных расходов (Фаза Р), который присылает САМ
// филиал: «самая свежая зеркальная проводка, которая у меня уже есть».
//
// Почему курсор именно от филиала, а не окно по дате на стороне central: всё
// остальное в down-sync самоограничено (каталог сети конечен, перемещения
// перестают выбираться после приёма), а зеркала расходов копятся без предела —
// отдавать их целиком каждые 20-30 секунд нельзя. Окно «за последние N дней»
// было бы проще, но у него есть режим тихой потери: касса, простоявшая офлайн
// дольше N, никогда не узнала бы о выплате, и её зарплатный кап перестал бы
// видеть уже выплаченное — то есть вернулся бы риск ДВОЙНОЙ выплаты, ради
// закрытия которого вся зеркальная схема и существует. Филиал же знает
// достоверно, что у него есть, сколько бы он ни отсутствовал.
//
// Сравнение идёт по created_at, проставленному ЦЕНТРОМ (филиал сохраняет то же
// значение из payload), поэтому расхождение часов между узлами на него не
// влияет. Граница нестрогая (>=) — при совпадении меток в одну секунду лучше
// прислать лишнее: применение идемпотентно (insert-if-absent по id).
func (s *SyncService) PullFor(ctx context.Context, restaurantID string, mirrorSince *time.Time) (*IngestInput, error) {
	if restaurantID == "" {
		return nil, apperrors.Wrap("VALIDATION", "restaurant_id is required", nil)
	}
	// Входящие (принять у себя) + Фаза Д2: СВОИ отправленные, которые получатель
	// уже принял — иначе у отправителя документ навсегда «отправлено»
	// (см. applyStatusEcho). Один запрос вместо двух: обе выборки узкие и
	// покрыты индексами по from/to.
	var transfers []models.StockTransfer
	if err := s.r.Raw().WithContext(ctx).
		Preload("Lines").
		Where("(to_restaurant_id = ? AND status = ?) OR (from_restaurant_id = ? AND status = ?)",
			restaurantID, "sent", restaurantID, "received").
		Order("created_at ASC").
		Find(&transfers).Error; err != nil {
		return nil, err
	}
	out := &IngestInput{Entries: make([]SyncEntry, 0, len(transfers))}
	for i := range transfers {
		payload, err := json.Marshal(transfers[i])
		if err != nil {
			return nil, err
		}
		out.Entries = append(out.Entries, SyncEntry{
			Entity: "stock_transfers", RowID: transfers[i].ID, Op: "insert", Payload: payload,
		})
	}

	// Денежные переводы (Фаза Д) — та же пара выборок, тот же смысл.
	var money []models.MoneyTransfer
	if err := s.r.Raw().WithContext(ctx).
		Where("(to_restaurant_id = ? AND status = ?) OR (from_restaurant_id = ? AND status = ?)",
			restaurantID, "sent", restaurantID, "received").
		Order("created_at ASC").
		Find(&money).Error; err != nil {
		return nil, err
	}
	for i := range money {
		payload, err := json.Marshal(money[i])
		if err != nil {
			return nil, err
		}
		out.Entries = append(out.Entries, SyncEntry{
			Entity: "money_transfers", RowID: money[i].ID, Op: "insert", Payload: payload,
		})
	}

	// Мастер-меню сети (ADR-004) — филиал наследует его целиком.
	var rest models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Select("account_id").Where("id = ?", restaurantID).First(&rest).Error; err == nil &&
		rest.AccountID != nil && *rest.AccountID != "" {
		var master []models.NetworkMenuItem
		if err := s.r.Raw().WithContext(ctx).Where("account_id = ?", *rest.AccountID).Find(&master).Error; err != nil {
			return nil, err
		}
		for i := range master {
			payload, err := json.Marshal(master[i])
			if err != nil {
				return nil, err
			}
			out.Entries = append(out.Entries, SyncEntry{
				Entity: "network_menu_items", RowID: master[i].ID, Op: "upsert", Payload: payload,
			})
		}

		// Номенклатура сети (ADR-003, вариант 3B) — тем же путём, что и мастер-меню
		// выше: central целиком отдаёт СВОЙ локальный каталог на каждый pull
		// (account-scoped, без курсора). Раньше эта строка отсутствовала — товар,
		// заведённый в номенклатуре на central, никогда не попадал на филиал
		// (найдено вживую: «рис» создан на central, на филиале не появился).
		//
		// Фильтра deleted_at здесь НЕТ намеренно: удалённые записи обязаны
		// доехать как tombstone'ы. Пропусти их — и филиал не «узнал бы об
		// удалении», а просто не получил бы строку, то есть сохранил бы её у
		// себя навсегда (down-sync — insert-if-absent, исчезновение строки в
		// нём неотличимо от «её не прислали»). Разбор — в applyNomenclature.
		var nomenclature []models.Nomenclature
		if err := s.r.Raw().WithContext(ctx).Where("account_id = ?", *rest.AccountID).Find(&nomenclature).Error; err != nil {
			return nil, err
		}
		for i := range nomenclature {
			payload, err := json.Marshal(nomenclature[i])
			if err != nil {
				return nil, err
			}
			out.Entries = append(out.Entries, SyncEntry{
				Entity: "nomenclature", RowID: nomenclature[i].ID, Op: "upsert", Payload: payload,
			})
		}

		// Соседи по сети (central + прочие филиалы) — тем же путём. Филиал
		// узнаёт о central только из JoinNetwork (account_id + sync_settings),
		// но НИКОГДА не заводит у себя саму строку central как restaurants —
		// поэтому «Перемещения» (CreateTransfer ищет to_restaurant_id в
		// ЛОКАЛЬНОЙ restaurants) и ListBranches (dropdown получателя) не
		// видели вообще никого, включая central. Central после RedeemInvite
		// уже видит ВСЕХ (см. фикс v3.16.293) — отдаём филиалу зеркало этого
		// же списка, себя самого исключаем (сам о себе и так всё знает,
		// перезаписывать НЕ должны — задел бы license_key/license_expires_at
		// и остальные поля, которых в этом зеркале нет и быть не может).
		// Найдено вживую: «в перемещении нет филиала пишет» (2026-08-20).
		var neighbors []models.Restaurant
		if err := s.r.Raw().WithContext(ctx).
			Where("account_id = ? AND id != ?", *rest.AccountID, restaurantID).
			Find(&neighbors).Error; err != nil {
			return nil, err
		}
		for i := range neighbors {
			payload, err := json.Marshal(neighbors[i])
			if err != nil {
				return nil, err
			}
			out.Entries = append(out.Entries, SyncEntry{
				Entity: "restaurants", RowID: neighbors[i].ID, Op: "upsert", Payload: payload,
			})
		}

		// Зеркала расходов, которые центр оплатил ЗА этот филиал (Фаза Р).
		// Именно они делают затрату видимой в ОПиУ филиала и — критично —
		// в его зарплатном капе, который иначе не знал бы о выплате и
		// разрешил бы выплатить второй раз. Курсор mirrorSince — см. выше.
		// Окно — по updated_at, НЕ по created_at. Курсор обязан пропускать
		// вниз не только новые расходы, но и отмену старых: бухгалтер сидит в
		// центре и правит задним числом. Отмена не меняет created_at, поэтому
		// на окне по нему расход, отменённый после того как филиал получил
		// более свежие зеркала, не уехал бы вниз никогда.
		mirrors := s.r.Raw().WithContext(ctx).
			Where("target_restaurant_id = ?", restaurantID)
		if mirrorSince != nil {
			mirrors = mirrors.Where("updated_at >= ?", *mirrorSince)
		}
		var ops []models.FinancialOperation
		if err := mirrors.Order("updated_at ASC").Find(&ops).Error; err != nil {
			return nil, err
		}
		for i := range ops {
			// Филиалу уезжает ЗЕРКАЛО, а не проводка центра: у него не должно
			// быть ни счёта плательщика, ни признака «заплатил за кого-то»;
			// вместо этого — «за нас заплатил вот этот узел».
			m := ops[i]
			m.ID = mirrorOpID(ops[i].ID)
			m.AccountID, m.AccountName = nil, nil
			m.TargetRestaurantID = nil
			m.PaidByRestaurantID = m.RestaurantID
			m.RestaurantID = &restaurantID
			m.ShiftID = nil // смена — понятие кассы плательщика, у филиала её нет
			payload, err := json.Marshal(m)
			if err != nil {
				return nil, err
			}
			out.Entries = append(out.Entries, SyncEntry{
				Entity: "financial_operations", RowID: m.ID, Op: "insert", Payload: payload,
			})
		}
	}
	return out, nil
}

// mirrorOpNS — фиксированное пространство имён для id зеркальных проводок.
// Значение произвольно, но менять его нельзя: от него зависит совпадение id
// при повторной доставке.
var mirrorOpNS = uuid.MustParse("6f1b7c2e-9d3a-4f58-8b21-0e5a7c9d4f10")

// mirrorOpID — id зеркальной проводки, ДЕТЕРМИНИРОВАННО выведенный из id
// проводки плательщика (UUIDv5).
//
// Свой id, а не общий с оригиналом, по двум причинам. Во-первых,
// financial_operations.id — первичный ключ: стоит обеим строкам оказаться в
// одной БД (а на центре так и есть, если он же и филиал в другой сети, или
// просто при разборе на копии базы), и вставка ломается либо, что хуже, одна
// строка молча затирает другую — платёж теряет счёт и исчезает из кассы.
// Во-вторых, id обязан быть ВОСПРОИЗВОДИМЫМ: зеркало отдаётся повторно, пока
// филиал не подтвердит его курсором, и каждая доставка должна попадать в ту же
// строку (insert-if-absent), а не плодить дубли зарплаты в его ОПиУ.
func mirrorOpID(sourceID string) string {
	return uuid.NewSHA1(mirrorOpNS, []byte(sourceID)).String()
}

// applyFinancialOp — upsert денежной операции из payload (для сводки владельцу).
// Только запись строки; балансы счетов на центральном узле НЕ трогаем (они —
// производные операций филиала, сводку считаем из financial_operations).
// Delete (Ф5) — закрывает пробел: DeleteExpense/DeleteOperation на филиале
// реально удаляют связанную финоперацию при отмене кассового расхода.
func (s *SyncService) applyFinancialOp(ctx context.Context, e SyncEntry, updateAll bool) error {
	if e.Op == "delete" {
		if e.RowID == "" {
			return apperrors.Wrap("VALIDATION", "financial_operations delete missing row_id", nil)
		}
		return s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
			// Если удаляют зеркало расхода, оплаченного за нас другим узлом
			// (Фаза Р), — удалить проводку мало, надо ОТКАТИТЬ её доменные
			// последствия, иначе долг поставщику остался бы погашенным, а срок
			// аренды — сдвинутым. Штатная отмена приходит не сюда, а soft-
			// пометкой cancelled_at (см. ниже), но путь удаления обязан быть
			// не менее корректным: строку читаем ДО удаления — после него
			// неоткуда узнать ни сумму, ни на что она ссылалась.
			var existing models.FinancialOperation
			err := tx.Where("id = ?", e.RowID).First(&existing).Error
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil // уже удалена — повторная доставка отмены, это норма
			}
			if err != nil {
				return err
			}
			res := tx.Where("id = ?", e.RowID).Delete(&models.FinancialOperation{})
			if res.Error != nil {
				return res.Error
			}
			// Откат — строго при РЕАЛЬНОМ удалении: отмена, как и сам платёж,
			// доставляется повторно, а долг и срок величины накопительные.
			if res.RowsAffected == 0 || existing.PaidByRestaurantID == nil {
				return nil
			}
			return reverseMirrorSideEffect(tx, &existing)
		})
	}
	var op models.FinancialOperation
	if err := json.Unmarshal(e.Payload, &op); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid financial_operations payload", err)
	}
	if op.ID == "" {
		return apperrors.Wrap("VALIDATION", "financial_operations payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		res := tx.Clauses(conflict).Create(&op)
		if res.Error != nil {
			return res.Error
		}
		if updateAll || op.PaidByRestaurantID == nil {
			return nil
		}
		// Зеркало уже лежало у нас: единственное, что могло измениться на
		// центре — отмена. Гасим её ровно один раз: условие cancelled_at IS
		// NULL делает это самой БД, поэтому повторные доставки (а зеркало
		// приходит повторно, пока курсор не сдвинется) откат не удваивают.
		// updated_at берём ЦЕНТРАЛЬНЫЙ, не свой now: по нему филиал ведёт
		// курсор, а часы узлов не совпадают.
		if res.RowsAffected == 0 {
			if op.CancelledAt == nil {
				return nil
			}
			upd := tx.Model(&models.FinancialOperation{}).
				Where("id = ? AND cancelled_at IS NULL", op.ID).
				Updates(map[string]any{
					"cancelled_at": op.CancelledAt, "cancelled_by": op.CancelledBy,
					"updated_at": op.UpdatedAt,
				})
			if upd.Error != nil || upd.RowsAffected == 0 {
				return upd.Error
			}
			return reverseMirrorSideEffect(tx, &op)
		}
		// Доменный эффект зеркального расхода (Фаза Р) — СТРОГО при первой
		// вставке. Зеркало отдаётся повторно, пока филиал не подтвердит его
		// курсором, а долг накладной и срок регулярного платежа — величины
		// накопительные: применить их дважды значит испортить данные. Признак
		// «строка реально появилась» — RowsAffected от insert-if-absent; при
		// updateAll (приём на central) эффекта нет вовсе — там просто зеркало
		// чужой БД, а документы живут у филиала.
		//
		// Расход, отменённый ещё до того как филиал впервые его увидел (был в
		// оффлайне всю дорогу), приезжает сразу с cancelled_at — применять его
		// последствия нельзя, иначе долг погасился бы отменённым платежом.
		if op.CancelledAt != nil {
			return nil
		}
		return applyMirrorSideEffect(tx, &op)
	})
}

// applyMirrorSideEffect — что филиал доделывает, получив расход, оплаченный за
// него другим узлом (Фаза Р). Сама проводка уже записана; здесь — доменные
// последствия, без которых его учёт разъедется:
//
//   - source_ref указывает на его накладную → гасим долг ровно так же, как это
//     сделала бы локальная оплата (StockService.PayReceipt): долг −сумма,
//     оплачено +сумма, payment_type пересчитан, у поставщика current_debt тоже
//     уменьшен. Без этого филиал считал бы, что всё ещё должен поставщику.
//   - source_ref указывает на его регулярный платёж → двигаем срок, как
//     RecurringPaymentsService.Pay. Без этого «Аренда» осталась бы вечно
//     просроченной, хотя её оплатил центр.
//
// Различаем по тому, КУДА указывает source_ref: id уникальны, поиск по двум
// таблицам однозначен. Отдельного поля-маркера не заводим — оно дублировало бы
// то, что и так выводится из данных. Ничего не нашли (например, source_ref —
// это user_id зарплатной выплаты) → эффекта нет, и это штатно.
func applyMirrorSideEffect(tx *gorm.DB, op *models.FinancialOperation) error {
	if op.SourceRef == nil || *op.SourceRef == "" || op.RestaurantID == nil {
		return nil
	}
	ref, rid, now := *op.SourceRef, *op.RestaurantID, time.Now().UTC()

	var receipt models.StockReceipt
	err := tx.Where("id = ? AND restaurant_id = ?", ref, rid).First(&receipt).Error
	if err == nil {
		return payReceiptDebt(tx, &receipt, op.Amount, now)
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}

	var rp models.RecurringPayment
	err = tx.Where("id = ? AND restaurant_id = ?", ref, rid).First(&rp).Error
	if err == nil {
		return advanceRecurringDue(tx, &rp, now)
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	return nil
}

// reverseMirrorSideEffect — откат последствий отменённого расхода. Зеркало
// applyMirrorSideEffect: тот же поиск по source_ref, обратные операции.
func reverseMirrorSideEffect(tx *gorm.DB, op *models.FinancialOperation) error {
	if op.SourceRef == nil || *op.SourceRef == "" || op.RestaurantID == nil {
		return nil
	}
	ref, rid, now := *op.SourceRef, *op.RestaurantID, time.Now().UTC()

	var receipt models.StockReceipt
	err := tx.Where("id = ? AND restaurant_id = ?", ref, rid).First(&receipt).Error
	if err == nil {
		return restoreReceiptDebt(tx, &receipt, op.Amount, now)
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}

	var rp models.RecurringPayment
	err = tx.Where("id = ? AND restaurant_id = ?", ref, rid).First(&rp).Error
	if err == nil {
		return retreatRecurringDue(tx, &rp, now)
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	return nil
}

// restoreReceiptDebt — возврат долга накладной после отмены оплаты. Клампим
// по уже оплаченной сумме: вернуть больше, чем было погашено, нельзя, иначе
// накладная ушла бы в долг сверх собственной стоимости.
func restoreReceiptDebt(tx *gorm.DB, receipt *models.StockReceipt, amount decimal.Decimal, now time.Time) error {
	back := amount
	if back.GreaterThan(receipt.PaidAmount) {
		back = receipt.PaidAmount
	}
	if !decimal.IsPositive(back) {
		return nil
	}
	receipt.DebtAmount = decimal.Normalize(decimal.Add(receipt.DebtAmount, back))
	receipt.PaidAmount = decimal.Normalize(decimal.Sub(receipt.PaidAmount, back))
	payType := "partial"
	if !decimal.IsPositive(receipt.PaidAmount) {
		payType = "credit" // не оплачено вовсе — как до первого платежа
	}
	if err := tx.Model(receipt).Updates(map[string]any{
		"debt_amount": receipt.DebtAmount, "paid_amount": receipt.PaidAmount,
		"payment_type": payType, "updated_at": now,
	}).Error; err != nil {
		return err
	}
	if err := recordReceiptSync(tx, []string{receipt.ID}); err != nil {
		return err
	}
	if receipt.SupplierID == nil || *receipt.SupplierID == "" {
		return nil
	}
	var sup models.Supplier
	if err := tx.Where("id = ?", *receipt.SupplierID).First(&sup).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		return err
	}
	if err := tx.Model(&sup).Updates(map[string]any{
		"current_debt": decimal.Normalize(decimal.Add(sup.CurrentDebt, back)),
		"updated_at":   now,
	}).Error; err != nil {
		return err
	}
	return recordSupplierSync(tx, []string{sup.ID})
}

// retreatRecurringDue — откат срока регулярного платежа на месяц назад.
// Симметрично advanceRecurringDue: каждый платёж двигал срок ровно на один
// шаг, поэтому обратный шаг возвращает его на место и при нескольких платежах
// подряд. last_paid_at обнуляем: прежнего значения мы не храним, а оставить
// его от отменённого платежа — соврать, что платёж был.
func retreatRecurringDue(tx *gorm.DB, rp *models.RecurringPayment, now time.Time) error {
	if rp.NextDue == nil || *rp.NextDue == "" {
		return nil
	}
	prev := retreatMonth(*rp.NextDue, rp.DayOfMonth)
	if err := tx.Model(rp).Updates(map[string]any{
		"next_due": prev, "last_paid_at": nil, "updated_at": now,
	}).Error; err != nil {
		return err
	}
	return recordRecurringPaymentSync(tx, []string{rp.ID})
}

// payReceiptDebt — гашение долга накладной БЕЗ движения денег (их уже списал
// плательщик). Арифметика и клампы — как в StockService.PayReceipt, включая
// защиту current_debt от ухода в минус при дрейфе денормализации.
func payReceiptDebt(tx *gorm.DB, receipt *models.StockReceipt, amount decimal.Decimal, now time.Time) error {
	pay := amount
	if pay.GreaterThan(receipt.DebtAmount) {
		pay = receipt.DebtAmount // не переплачиваем долг накладной
	}
	if !decimal.IsPositive(pay) {
		return nil
	}
	receipt.DebtAmount = decimal.Normalize(decimal.Sub(receipt.DebtAmount, pay))
	receipt.PaidAmount = decimal.Normalize(decimal.Add(receipt.PaidAmount, pay))
	payType := "partial"
	if !decimal.IsPositive(receipt.DebtAmount) {
		payType = "paid"
	}
	if err := tx.Model(receipt).Updates(map[string]any{
		"debt_amount": receipt.DebtAmount, "paid_amount": receipt.PaidAmount,
		"payment_type": payType, "updated_at": now,
	}).Error; err != nil {
		return err
	}
	// Изменённый долг — наверх. Это НЕ эхо репликации, а собственное следствие
	// доменной логики филиала, и central обязан его увидеть: иначе в сетевых
	// отчётах долг поставщику остался бы прежним, хотя центр его уже погасил.
	// Цикла нет: накладные и поставщики вниз не ездят.
	if err := recordReceiptSync(tx, []string{receipt.ID}); err != nil {
		return err
	}
	if receipt.SupplierID == nil || *receipt.SupplierID == "" {
		return nil
	}
	var sup models.Supplier
	if err := tx.Where("id = ?", *receipt.SupplierID).First(&sup).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		return err
	}
	nd := decimal.Sub(sup.CurrentDebt, pay)
	if decimal.IsNegative(nd) {
		nd = decimal.Zero
	}
	if err := tx.Model(&sup).Updates(map[string]any{
		"current_debt": decimal.Normalize(nd), "updated_at": now,
	}).Error; err != nil {
		return err
	}
	return recordSupplierSync(tx, []string{sup.ID})
}

// advanceRecurringDue — сдвиг срока регулярного платежа, когда его оплатил
// central за филиал (Фаза Р). База — сам next_due, а не сегодня: ритм дня
// месяца сохраняется, даже если платёж провели раньше или позже.
//
// ⚠️ В ОТЛИЧИЕ от RecurringPaymentsService.Pay (остаток текущего цикла при
// частичной оплате) — здесь amount не участвует, срок двигается безусловно.
// Мирроринг центр→филиал пока не знает о remaining_amount; если центр гасит
// филиальский долг частями, это не отражается тут же, как в локальной
// оплате. Не совпадающий с локальным путём кусок, а не забытый — не трогаем,
// пока в частичных платежах через сеть нет реального кейса.
func advanceRecurringDue(tx *gorm.DB, rp *models.RecurringPayment, now time.Time) error {
	base := now.Format("2006-01-02")
	if rp.NextDue != nil && *rp.NextDue != "" {
		base = *rp.NextDue
	}
	nd := advanceMonth(base, rp.DayOfMonth)
	if err := tx.Model(rp).Updates(map[string]any{
		"next_due": nd, "last_paid_at": now, "updated_at": now,
	}).Error; err != nil {
		return err
	}
	return recordRecurringPaymentSync(tx, []string{rp.ID})
}

// applyFinancialAccount — upsert/delete снапшота счёта (Ф5). Приходит на
// каждый Create/Update (generic trackedSave-хук, synclog/recorder_hook.go) —
// частота ≈ каждая денежная операция в системе, central всегда видит
// актуальный баланс филиала. Delete — настоящий (hard, FinancialAccountsService.
// Delete), как у suppliers/ingredients/tables.
func (s *SyncService) applyFinancialAccount(ctx context.Context, e SyncEntry, updateAll bool) error {
	if e.Op == "delete" {
		if e.RowID == "" {
			return apperrors.Wrap("VALIDATION", "financial_accounts delete missing row_id", nil)
		}
		return s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
			return tx.Where("id = ?", e.RowID).Delete(&models.FinancialAccount{}).Error
		})
	}
	var acc models.FinancialAccount
	if err := json.Unmarshal(e.Payload, &acc); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid financial_accounts payload", err)
	}
	if acc.ID == "" {
		return apperrors.Wrap("VALIDATION", "financial_accounts payload missing id", nil)
	}
	// IsEnabled — bool (не указатель) с gorm:"default:true": GORM's
	// ConvertToCreateValues (callbacks/create.go) БЕЗУСЛОВНО подменяет
	// zero-значение поля (false) значением из default-тега (true) при
	// Create()/ON CONFLICT DO UPDATE — это внутренняя логика построения
	// VALUES, Select("*")/Omit её не отключают (проверено чтением исходников
	// GORM). Хуже: подмена пишет исправленное значение ОБРАТНО в саму
	// переданную структуру (field.Set(...)) — поэтому значение нужно
	// захватить ДО Create(), иначе acc.IsEnabled к моменту форс-апдейта уже
	// испорчено самим Create(). Map-based Update этой подмене не подвержен
	// (другой путь в GORM — ConvertToAssignments, не ConvertToCreateValues).
	wantEnabled := acc.IsEnabled
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		if err := tx.Clauses(conflict).Create(&acc).Error; err != nil {
			return err
		}
		return tx.Model(&models.FinancialAccount{ID: acc.ID}).Update("is_enabled", wantEnabled).Error
	})
}

// applyRecurringPayment — upsert/delete снапшота регулярного платежа (Ф5).
// Delete — настоящий (hard, RecurringPaymentsService.Delete).
func (s *SyncService) applyRecurringPayment(ctx context.Context, e SyncEntry, updateAll bool) error {
	if e.Op == "delete" {
		if e.RowID == "" {
			return apperrors.Wrap("VALIDATION", "recurring_payments delete missing row_id", nil)
		}
		return s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
			return tx.Where("id = ?", e.RowID).Delete(&models.RecurringPayment{}).Error
		})
	}
	var rp models.RecurringPayment
	if err := json.Unmarshal(e.Payload, &rp); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid recurring_payments payload", err)
	}
	if rp.ID == "" {
		return apperrors.Wrap("VALIDATION", "recurring_payments payload missing id", nil)
	}
	// Active — та же ловушка, что у FinancialAccount.IsEnabled (bool +
	// gorm:"default:true", см. подробный комментарий в applyFinancialAccount) —
	// захватываем ДО Create(), которая испортит rp.Active обратной записью.
	wantActive := rp.Active
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		if err := tx.Clauses(conflict).Create(&rp).Error; err != nil {
			return err
		}
		return tx.Model(&models.RecurringPayment{ID: rp.ID}).Update("active", wantActive).Error
	})
}

// ─── Ф5б «Персонал» ─────────────────────────────────────────────────────────
// time_entries/salary_worked_days/salary_day_multipliers/salary_deductions/
// salary_advances — ни у одной нет bool/int-поля с gorm:"default:..." И
// зоной риска zero-value одновременно (Multiplier у salary_day_multipliers
// формально имеет default:2, но реально ВСЕГДА создаётся со значением 2 —
// payload из JSON никогда не даёт Go zero-value для этого поля, поэтому
// GORM-ловушка из applyFinancialAccount/applyRecurringPayment здесь физически
// не может сработать — обычный Create+OnConflict без force-Update.

func (s *SyncService) applyTimeEntry(ctx context.Context, e SyncEntry, updateAll bool) error {
	if e.Op == "delete" {
		if e.RowID == "" {
			return apperrors.Wrap("VALIDATION", "time_entries delete missing row_id", nil)
		}
		return s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
			return tx.Where("id = ?", e.RowID).Delete(&models.TimeEntry{}).Error
		})
	}
	var row models.TimeEntry
	if err := json.Unmarshal(e.Payload, &row); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid time_entries payload", err)
	}
	if row.ID == "" {
		return apperrors.Wrap("VALIDATION", "time_entries payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&row).Error
	})
}

func (s *SyncService) applySalaryWorkedDay(ctx context.Context, e SyncEntry, updateAll bool) error {
	if e.Op == "delete" {
		if e.RowID == "" {
			return apperrors.Wrap("VALIDATION", "salary_worked_days delete missing row_id", nil)
		}
		return s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
			return tx.Where("id = ?", e.RowID).Delete(&models.SalaryWorkedDay{}).Error
		})
	}
	var row models.SalaryWorkedDay
	if err := json.Unmarshal(e.Payload, &row); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid salary_worked_days payload", err)
	}
	if row.ID == "" {
		return apperrors.Wrap("VALIDATION", "salary_worked_days payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&row).Error
	})
}

func (s *SyncService) applySalaryDayMultiplier(ctx context.Context, e SyncEntry, updateAll bool) error {
	if e.Op == "delete" {
		if e.RowID == "" {
			return apperrors.Wrap("VALIDATION", "salary_day_multipliers delete missing row_id", nil)
		}
		return s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
			return tx.Where("id = ?", e.RowID).Delete(&models.SalaryDayMultiplier{}).Error
		})
	}
	var row models.SalaryDayMultiplier
	if err := json.Unmarshal(e.Payload, &row); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid salary_day_multipliers payload", err)
	}
	if row.ID == "" {
		return apperrors.Wrap("VALIDATION", "salary_day_multipliers payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&row).Error
	})
}

// applySalaryDeduction — только upsert: SalaryDeduction никогда не
// hard-удаляется (CancelDeduction — soft, cancelled_at/by), делать branch
// нет причин.
func (s *SyncService) applySalaryDeduction(ctx context.Context, e SyncEntry, updateAll bool) error {
	var row models.SalaryDeduction
	if err := json.Unmarshal(e.Payload, &row); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid salary_deductions payload", err)
	}
	if row.ID == "" {
		return apperrors.Wrap("VALIDATION", "salary_deductions payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&row).Error
	})
}

// applySalaryAdvance — только upsert: SalaryAdvance никогда не
// hard-удаляется (CancelAdvance — soft), тот же случай, что и deduction.
func (s *SyncService) applySalaryAdvance(ctx context.Context, e SyncEntry, updateAll bool) error {
	var row models.SalaryAdvance
	if err := json.Unmarshal(e.Payload, &row); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid salary_advances payload", err)
	}
	if row.ID == "" {
		return apperrors.Wrap("VALIDATION", "salary_advances payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&row).Error
	})
}

// applyNetworkMenuTechCards — техкарты мастера на филиале (миграция 085).
// Пустой снапшот = «мастер техкартами не управляет» (у всех старых мастеров
// так): локальные техкарты филиала не трогаются. Непустой — авторитет центра:
// строки продукта и вариантов заменяются на снапшотные целиком, включая
// «пустая техкарта» (ключ с пустым списком).
//
// Ингредиенты разрешаются через ensureNomenclatureIngredient — тот же мост,
// что у приёма перемещений: связанный товар переиспользуется, отсутствующий
// создаётся с нулевым остатком. Полуфабрикаты — по (имя, размер); недостающие
// создаются вместе с рецептом, СУЩЕСТВУЮЩИЕ НЕ ПЕРЕЗАПИСЫВАЮТСЯ (рецепт
// заготовки — авторитет узла, который её реально готовит).
//
// От пересинка каждый тик защищает сравнение сигнатур (без цен — у каждого
// узла своя себестоимость). Ключи, чей вариант на филиале не существует
// (рассинхрон снапшота с attributes), выбрасываются из ОБЕИХ сторон сравнения
// — иначе недостижимый ключ гонял бы применение бесконечно.
func (s *SyncService) applyNetworkMenuTechCards(ctx context.Context, branchID, productID string, m *models.NetworkMenuItem) error {
	if productID == "" || len(m.TechCards) == 0 || string(m.TechCards) == "null" {
		return nil
	}
	var snap NetworkTechCards
	if err := json.Unmarshal(m.TechCards, &snap); err != nil || len(snap.Cards) == 0 {
		return nil // битый снапшот не должен ронять весь pull
	}

	db := s.r.Raw().WithContext(ctx)
	labelKeys, err := variantLabelKeys(db, branchID, productID)
	if err != nil {
		return err
	}
	itemByKey := map[string]string{"": productID}
	for itemID, key := range labelKeys {
		itemByKey[key] = itemID
	}

	// Сравнение — только по разрешимым локально ключам.
	managed := NetworkTechCards{Cards: map[string][]NetworkTechCardLine{}}
	for key, lines := range snap.Cards {
		if _, ok := itemByKey[key]; ok {
			managed.Cards[key] = lines
		}
	}
	if len(managed.Cards) == 0 {
		return nil
	}
	local, err := localTechCardsSnapshot(db, branchID, itemByKey, managed.Cards)
	if err != nil {
		return err
	}
	if techCardsSignature(local) == techCardsSignature(&managed) {
		return nil
	}

	now := time.Now().UTC()
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		touched := make([]string, 0, len(managed.Cards))
		for key, lines := range managed.Cards {
			itemID := itemByKey[key]
			if err := tx.Where("menu_item_id = ?", itemID).Delete(&models.TechCardLine{}).Error; err != nil {
				return err
			}
			for i := range lines {
				l := lines[i]
				qty, qerr := decimal.FromString(l.Qty)
				if qerr != nil {
					continue
				}
				row := models.TechCardLine{
					ID: uuid.NewString(), MenuItemID: &itemID,
					Qty: decimal.Normalize(qty), RestaurantID: &branchID, CreatedAt: now,
				}
				if l.Name != "" {
					row.Name = &l.Name
				}
				if l.Unit != "" {
					row.Unit = &l.Unit
				}
				switch {
				case l.Nom != "":
					price := decimal.Zero
					if p, perr := decimal.FromString(l.Price); perr == nil {
						price = p
					}
					nom, nm, un := l.Nom, l.Name, l.Unit
					ing, ierr := ensureNomenclatureIngredient(tx, branchID, ensureIngredientInput{
						NomenclatureID: &nom, Name: &nm, Unit: &un, PricePerUnit: price, Now: now,
					})
					if ierr != nil {
						return ierr
					}
					row.IngredientID = &ing.ID
				case l.Semi != nil:
					semiID, serr := ensureSemiTypeFromSpec(tx, branchID, l.Semi, now)
					if serr != nil {
						return serr
					}
					if semiID == "" {
						continue
					}
					row.SemiTypeID = &semiID
					if row.Name == nil || *row.Name == "" {
						row.Name = &l.Semi.Name
					}
				default:
					continue
				}
				if err := tx.Create(&row).Error; err != nil {
					return err
				}
			}
			recomputeMenuItemCogs(tx, branchID, itemID, now)
			touched = append(touched, itemID)
		}
		// Блюда с новой техкартой/себестоимостью — наверх, чтобы central видел
		// актуальный cogs филиала в branch-view меню.
		return recordMenuItemsSync(tx, touched)
	})
}

// localTechCardsSnapshot — фактические техкарты филиала в форме снапшота
// мастера (для сравнения сигнатур): ингредиенты → их nomenclature_id
// (несвязанный руками заведённый товар даёт «локальный» маркер и сигнатуры
// расходятся — строка будет заменена управляемой), полуфабрикаты → (имя,
// размер).
func localTechCardsSnapshot(db *gorm.DB, rid string, itemByKey map[string]string, managed map[string][]NetworkTechCardLine) (*NetworkTechCards, error) {
	out := &NetworkTechCards{Cards: map[string][]NetworkTechCardLine{}}
	for key := range managed {
		itemID := itemByKey[key]
		var lines []models.TechCardLine
		if err := db.Where("restaurant_id = ? AND menu_item_id = ?", rid, itemID).Find(&lines).Error; err != nil {
			return nil, err
		}
		conv := make([]NetworkTechCardLine, 0, len(lines))
		for i := range lines {
			l := lines[i]
			nl := NetworkTechCardLine{Qty: decimal.Normalize(l.Qty).String(), Unit: derefOr(l.Unit, "")}
			switch {
			case l.IngredientID != nil && *l.IngredientID != "":
				var ing models.Ingredient
				if err := db.Select("nomenclature_id").Where("id = ?", *l.IngredientID).First(&ing).Error; err == nil &&
					ing.NomenclatureID != nil && *ing.NomenclatureID != "" {
					nl.Nom = *ing.NomenclatureID
				} else {
					nl.Nom = "local:" + *l.IngredientID
				}
			case l.SemiTypeID != nil && *l.SemiTypeID != "":
				var st models.SemiFinishedType
				if err := db.Where("id = ?", *l.SemiTypeID).First(&st).Error; err != nil {
					continue
				}
				spec := &NetworkSemiSpec{Name: derefOr(st.Name, "")}
				if st.SizeScaleValueID != nil && *st.SizeScaleValueID != "" {
					var sv models.SizeScaleValue
					if err := db.Where("id = ?", *st.SizeScaleValueID).First(&sv).Error; err == nil {
						spec.Size = sv.Code
						if sv.Title != nil && *sv.Title != "" {
							spec.Size = *sv.Title
						}
					}
				}
				nl.Semi = spec
			default:
				continue
			}
			conv = append(conv, nl)
		}
		out.Cards[key] = conv
	}
	return out, nil
}

// ensureSemiTypeFromSpec — полуфабрикат филиала по описанию из снапшота:
// поиск по (имя, размер) без регистра; найденный используется как есть
// (рецепт НЕ перезаписывается), отсутствующий создаётся вместе с рецептом.
func ensureSemiTypeFromSpec(tx *gorm.DB, rid string, spec *NetworkSemiSpec, now time.Time) (string, error) {
	if strings.TrimSpace(spec.Name) == "" {
		return "", nil
	}
	var candidates []models.SemiFinishedType
	if err := tx.Where("restaurant_id = ? AND LOWER(name) = LOWER(?)", rid, strings.TrimSpace(spec.Name)).
		Find(&candidates).Error; err != nil {
		return "", err
	}
	wantSize := strings.ToLower(strings.TrimSpace(spec.Size))
	for i := range candidates {
		st := candidates[i]
		size := ""
		if st.SizeScaleValueID != nil && *st.SizeScaleValueID != "" {
			var sv models.SizeScaleValue
			if err := tx.Where("id = ?", *st.SizeScaleValueID).First(&sv).Error; err == nil {
				size = sv.Code
				if sv.Title != nil && *sv.Title != "" {
					size = *sv.Title
				}
			}
		}
		if strings.ToLower(strings.TrimSpace(size)) == wantSize {
			return st.ID, nil
		}
	}

	name := strings.TrimSpace(spec.Name)
	outputUnit := spec.OutputUnit
	st := models.SemiFinishedType{
		ID: uuid.NewString(), Name: &name, RestaurantID: &rid, CreatedAt: now, UpdatedAt: now,
	}
	if outputUnit != "" {
		st.OutputUnit = &outputUnit
	}
	if y, err := decimal.FromString(spec.Yield); err == nil && decimal.IsPositive(y) {
		st.YieldPercent = y
	}
	if wantSize != "" {
		// Значение локальной шкалы с этим лейблом (шкалу создала материализация
		// вариаций; нет — тег размера просто не проставится, это не ошибка).
		var sv models.SizeScaleValue
		if err := tx.Where("restaurant_id = ? AND (LOWER(code) = ? OR LOWER(title) = ?)", rid, wantSize, wantSize).
			First(&sv).Error; err == nil {
			st.SizeScaleValueID = &sv.ID
		}
	}
	if err := tx.Create(&st).Error; err != nil {
		return "", err
	}
	for i := range spec.Recipe {
		rl := spec.Recipe[i]
		if rl.Nom == "" {
			continue
		}
		qty, qerr := decimal.FromString(rl.QtyPerUnit)
		if qerr != nil {
			continue
		}
		price := decimal.Zero
		if p, perr := decimal.FromString(rl.Price); perr == nil {
			price = p
		}
		nom, nm, un := rl.Nom, rl.Name, rl.Unit
		ing, ierr := ensureNomenclatureIngredient(tx, rid, ensureIngredientInput{
			NomenclatureID: &nom, Name: &nm, Unit: &un, PricePerUnit: price, Now: now,
		})
		if ierr != nil {
			return "", ierr
		}
		line := models.SemiRecipeLine{
			ID: uuid.NewString(), SemiTypeID: &st.ID, IngredientID: &ing.ID,
			QtyPerUnit: decimal.Normalize(qty), CreatedAt: now,
		}
		if rl.Name != "" {
			line.Name = &rl.Name
		}
		if rl.Unit != "" {
			line.Unit = &rl.Unit
		}
		if err := tx.Create(&line).Error; err != nil {
			return "", err
		}
	}
	return st.ID, nil
}
