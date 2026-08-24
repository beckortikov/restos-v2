package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// NetworkService — сетевые справочники для multi-branch (ADR-003, Фаза 1):
// филиалы сети + общий каталог номенклатуры + привязка ингредиентов.
//
// account_id выводим из ресторана в контексте (не из middleware): эти эндпоинты
// доступны любой роли филиала, а сеть определяется рестораном, в котором
// залогинен пользователь.
type NetworkService struct {
	r *repo.Repo
	// syncToken — АКТИВНЫЙ sync-секрет этого узла (тот, что реально проверяет
	// SyncAuth middleware прямо сейчас — см. main.go: sync_settings из БД
	// переопределяет env при старте, но НЕ пишется обратно в БД). RedeemInvite
	// обязан отдавать именно это значение, не читать sync_settings.token
	// заново из БД — та колонка может быть пустой/устаревшей относительно
	// того, что реально забинжено в роутер (см. ADR-003, продолжение).
	syncToken string
}

func NewNetworkService(r *repo.Repo, syncToken string) *NetworkService {
	return &NetworkService{r: r, syncToken: syncToken}
}

// accountForCtx — account_id ресторана из контекста; ErrValidation если не в сети.
func (s *NetworkService) accountForCtx(ctx context.Context) (string, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return "", err
	}
	var rest models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Select("account_id").Where("id = ?", rid).First(&rest).Error; err != nil {
		return "", err
	}
	if rest.AccountID == nil || *rest.AccountID == "" {
		return "", apperrors.Wrap("VALIDATION", "restaurant is not part of a network", nil)
	}
	return *rest.AccountID, nil
}

// Branch — короткое представление филиала сети.
type Branch struct {
	ID   string  `json:"id"`
	Name string  `json:"name"`
	Kind *string `json:"kind"`
}

// ListBranches возвращает все рестораны сети (включая текущий). Если ресторан
// не в сети — возвращает только его самого (одиночный режим).
func (s *NetworkService) ListBranches(ctx context.Context) ([]Branch, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	var self models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", rid).First(&self).Error; err != nil {
		return nil, err
	}
	var rows []models.Restaurant
	if self.AccountID == nil || *self.AccountID == "" {
		rows = []models.Restaurant{self}
	} else {
		if err := s.r.Raw().WithContext(ctx).
			Where("account_id = ?", *self.AccountID).
			Order("kind DESC, name ASC"). // central_warehouse выше outlet
			Find(&rows).Error; err != nil {
			return nil, err
		}
	}
	out := make([]Branch, 0, len(rows))
	for _, r := range rows {
		out = append(out, Branch{ID: r.ID, Name: r.Name, Kind: r.Kind})
	}
	return out, nil
}

// ListNomenclature возвращает общий каталог номенклатуры сети.
func (s *NetworkService) ListNomenclature(ctx context.Context) ([]models.Nomenclature, error) {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.Nomenclature
	if err := s.r.Raw().WithContext(ctx).
		Where("account_id = ? AND deleted_at IS NULL", account).
		Order("name ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// DeleteNomenclature убирает запись из общего каталога сети (Фаза Г).
//
// Мягкое удаление: строка помечается deleted_at и в таком виде доезжает до
// филиалов — иначе они бы её просто не «не получили» и сохранили навсегда
// (down-sync = insert-if-absent, см. миграцию 081).
//
// СВОЙ товар отвязываем сразу, здесь же; товары филиалов отвяжутся у них при
// получении tombstone (applyNomenclature). Именно ОТВЯЗЫВАЕМ, а не удаляем: у
// товара есть остаток и история движений, и уборка справочника не повод их
// уничтожать. Операция означает «перестал быть сетевым», а не «стёрт у всех».
func (s *NetworkService) DeleteNomenclature(ctx context.Context, id string) error {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return err
	}
	if err := requirePermFor(ctx, s.r, "inventory.manage"); err != nil {
		return err
	}
	now := time.Now().UTC()
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		res := tx.Model(&models.Nomenclature{}).
			Where("id = ? AND account_id = ? AND deleted_at IS NULL", id, account).
			Updates(map[string]any{"deleted_at": now, "updated_at": now})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return apperrors.ErrNotFound
		}

		// Свои товары — отвязать (не удалять!) и отправить их снапшот наверх,
		// иначе на central у них остался бы висеть nomenclature_id удалённой
		// записи.
		var ids []string
		if err := tx.Model(&models.Ingredient{}).
			Where("nomenclature_id = ?", id).Pluck("id", &ids).Error; err != nil {
			return err
		}
		if len(ids) > 0 {
			if err := tx.Model(&models.Ingredient{}).Where("id IN ?", ids).
				Update("nomenclature_id", nil).Error; err != nil {
				return err
			}
			if err := recordIngredientSync(tx, ids); err != nil {
				return err
			}
		}
		// Сам tombstone — наверх (если удалял филиал) и вниз (PullFor отдаёт
		// его вместе с живым каталогом).
		return recordNomenclatureSync(tx, []string{id})
	})
}

// CreateNomenclatureInput — body POST /api/v1/nomenclature.
type CreateNomenclatureInput struct {
	Name     string  `json:"name"`
	Unit     *string `json:"unit,omitempty"`
	Category *string `json:"category,omitempty"`
}

// CreateNomenclature заводит продукт в общий каталог сети.
func (s *NetworkService) CreateNomenclature(ctx context.Context, in CreateNomenclatureInput) (*models.Nomenclature, error) {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return nil, err
	}
	if in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	n := &models.Nomenclature{
		ID:        uuid.NewString(),
		AccountID: &account,
		Name:      in.Name,
		Unit:      in.Unit,
		Category:  in.Category,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		if err := tx.Create(n).Error; err != nil {
			return err
		}
		// Наверх — чтобы каталог оставался ОБЩИМ и когда запись завёл филиал
		// (Фаза Г). На central это no-op: там синк выключен.
		if err := recordNomenclatureSync(tx, []string{n.ID}); err != nil {
			return err
		}
		// Фаза М — материализуем товар и на СВОЁМ узле, а не только на филиалах
		// (те получат его down-sync'ом, см. applyNomenclature). Иначе выходило
		// бы странное: владелец завёл продукт в центре, тот появился у всех
		// филиалов, а на складе самого центра его нет.
		_, err := ensureNomenclatureIngredient(tx, rid, ensureIngredientInput{
			NomenclatureID: &n.ID,
			Name:           &n.Name,
			Unit:           n.Unit,
			PricePerUnit:   decimal.Zero,
			Now:            now,
		})
		return err
	}); err != nil {
		return nil, err
	}
	return n, nil
}

// LinkIngredient привязывает ингредиент текущего ресторана к номенклатуре сети.
func (s *NetworkService) LinkIngredient(ctx context.Context, ingredientID, nomenclatureID string) error {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return err
	}
	// Номенклатура должна принадлежать той же сети и быть живой: привязывать
	// товар к удалённой записи бессмысленно — tombstone тут же отвязал бы его
	// обратно на следующем тике синка.
	var nom models.Nomenclature
	if err := s.r.Raw().WithContext(ctx).
		Where("id = ? AND deleted_at IS NULL", nomenclatureID).First(&nom).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return apperrors.Wrap("VALIDATION", "nomenclature not found", nil)
		}
		return err
	}
	if nom.AccountID == nil || *nom.AccountID != account {
		return apperrors.Wrap("VALIDATION", "nomenclature belongs to a different network", nil)
	}
	// Обновляем только свой ингредиент (ForTenant — tenant-safe).
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		scoped, err := tr.ForTenant(ctx)
		if err != nil {
			return err
		}
		res := scoped.Model(&models.Ingredient{}).
			Where("id = ?", ingredientID).
			Update("nomenclature_id", nomenclatureID)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return apperrors.ErrNotFound
		}
		// Свежий scope: явный .Model() выше не гарантирует чистое состояние для
		// следующего запроса на том же scoped (см. [[gorm-scoped-double-model-call-bug]]).
		scoped2, err := tr.ForTenant(ctx)
		if err != nil {
			return err
		}
		return recordIngredientSync(scoped2, []string{ingredientID})
	})
}

// CreateNetwork заводит сеть (company_account) и делает ТЕКУЩИЙ ресторан её
// центральным складом. Ошибка, если ресторан уже в сети. Другие филиалы
// присоединяются к сети своим account_id (из лицензии на своей установке).
func (s *NetworkService) CreateNetwork(ctx context.Context, name string) (*models.CompanyAccount, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	var rest models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", rid).First(&rest).Error; err != nil {
		return nil, err
	}
	if rest.AccountID != nil && *rest.AccountID != "" {
		return nil, apperrors.Wrap("CONFLICT", "restaurant is already part of a network", nil)
	}
	if name == "" {
		name = rest.Name
	}
	now := time.Now().UTC()
	accountID := uuid.NewString()
	cw := "central_warehouse"
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		if err := tx.Create(&models.CompanyAccount{ID: accountID, Name: name, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
			return err
		}
		return tx.Model(&models.Restaurant{}).Where("id = ?", rid).
			Updates(map[string]any{"account_id": accountID, "kind": cw}).Error
	})
	if err != nil {
		return nil, err
	}
	return &models.CompanyAccount{ID: accountID, Name: name, CreatedAt: now, UpdatedAt: now}, nil
}

// SetBranchKind меняет тип филиала (outlet | central_warehouse) в рамках сети
// текущего ресторана.
func (s *NetworkService) SetBranchKind(ctx context.Context, restaurantID, kind string) error {
	if kind != "outlet" && kind != "central_warehouse" {
		return apperrors.Wrap("VALIDATION", "kind must be outlet or central_warehouse", nil)
	}
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return err
	}
	res := s.r.Raw().WithContext(ctx).Model(&models.Restaurant{}).
		Where("id = ? AND account_id = ?", restaurantID, account).
		Update("kind", kind)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// DetachBranch — отключить филиал от сети (ADR-003, Фаза У). Владелец
// центрального узла убирает точку, которая закрылась или больше не его.
//
// Механика — обнуление restaurants.account_id теневой строки филиала. Этого
// достаточно и это не разрушительно:
//   - branchesForAccount/ListBranches фильтруют по account_id, поэтому филиал
//     разом пропадает из ВСЕХ сетевых списков и отчётов, без правки шести
//     запросов по отдельности;
//   - PullFor для него становится пустым (там же проверка account_id != NULL),
//     то есть перестают уезжать вниз каталог, мастер-меню и соседи;
//   - НИ ОДНА строка данных не удаляется: заказы, деньги, склад, что филиал
//     уже прислал, остаются в БД central. Повторное подключение по коду
//     (RedeemInvite) возвращает account_id — и всё снова видно.
//
// Доступ при этом ТОЖЕ отзывается (с Фазы Г): SyncAuth опознаёт филиал по его
// персональному токену и, увидев пустой account_id, отвечает 401 — слать
// данные он больше не может. До появления персональных токенов этого не было:
// вся сеть жила на одном общем секрете, и отличить узлы друг от друга central
// не мог. Исключение — филиалы, подключённые до Фазы Г и знающие только общий
// секрет: у них доступ сохранится, пока они не переподключатся по коду и не
// получат свой токен.
//
// Незавершённые перемещения и переводы отключённому филиалу продолжают
// доезжать — деньги и товар по ним уже списаны у отправителя, обрыв доставки
// подвесил бы их навсегда (см. PullFor).
func (s *NetworkService) DetachBranch(ctx context.Context, restaurantID string) error {
	me, account, err := s.requireCentralOwner(ctx)
	if err != nil {
		return err
	}
	if restaurantID == me {
		return apperrors.Wrap("VALIDATION", "нельзя отключить сам центральный узел — сеть перестала бы существовать", nil)
	}
	res := s.r.Raw().WithContext(ctx).Model(&models.Restaurant{}).
		Where("id = ? AND account_id = ?", restaurantID, account).
		Update("account_id", nil)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// ── Мастер-меню сети (ADR-004) ──────────────────────────────────────────────

// ListNetworkMenu — мастер-меню сети текущего ресторана.
func (s *NetworkService) ListNetworkMenu(ctx context.Context) ([]models.NetworkMenuItem, error) {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.NetworkMenuItem
	if err := s.r.Raw().WithContext(ctx).
		Where("account_id = ?", account).Order("category ASC, name ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// NetworkMenuInput — body для create/update мастер-блюда.
type NetworkMenuInput struct {
	Name      string `json:"name"`
	Category  string `json:"category,omitempty"`
	BasePrice string `json:"base_price,omitempty"`
	Station   string `json:"station,omitempty"`
	Unit      string `json:"unit,omitempty"`
	Emoji     string `json:"emoji,omitempty"`
	// Attributes — вариации мастера (миграция 084). Семантика поля:
	// отсутствует (nil) — не трогать; JSON null — очистить (блюдо снова
	// плоское); объект — заменить. Форма — NetworkMenuAttrs.
	Attributes json.RawMessage `json:"attributes,omitempty"`
	// Available — стартовая доступность (миграция 086), только для Create:
	// применяется ОДИН РАЗ при первой материализации на филиале, дальше не
	// синкается (доступность — локальное решение узла). Опущено → true.
	Available *bool `json:"available,omitempty"`
}

// NetworkMenuAttrs — валидируемая форма network_menu_items.attributes.
// Повторяет SyncAttributesInput, но без id: id атрибутов/значений/шкал
// локальны для каждого узла и через сеть не ездят.
type NetworkMenuAttrs struct {
	Attributes []NetworkMenuAttr  `json:"attributes"`
	Combos     []NetworkMenuCombo `json:"combos"`
}

type NetworkMenuAttr struct {
	Name string `json:"name"`
	// Scale — применяющая сторона связывает атрибут со СВОЕЙ шкалой размеров
	// с этим именем (find-or-create), чтобы техкарты вариантов могли цеплять
	// заготовки по размеру.
	Scale  bool     `json:"scale,omitempty"`
	Values []string `json:"values"`
}

type NetworkMenuCombo struct {
	Labels []string `json:"labels"`
	Price  string   `json:"price"`
}

// parseNetworkMenuAttrs — разбор и проверка attributes из NetworkMenuInput.
// Возвращает (nil, false, nil) когда поле отсутствует, (nil, true, nil) когда
// прислан явный null (очистка). Лимиты — те же, что у локальных атрибутов
// (validateAttributesInput): до 3 атрибутов, до 10 значений, цена на каждую
// комбинацию — иначе материализация на филиале упадёт на ровно этих проверках.
func parseNetworkMenuAttrs(raw json.RawMessage) (*NetworkMenuAttrs, bool, error) {
	if raw == nil {
		return nil, false, nil
	}
	if string(bytes.TrimSpace(raw)) == "null" {
		return nil, true, nil
	}
	var a NetworkMenuAttrs
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, false, apperrors.Wrap("VALIDATION", "attributes: некорректный JSON", err)
	}
	if len(a.Attributes) == 0 {
		return nil, true, nil // пустой объект — тоже очистка
	}
	if len(a.Attributes) > 3 {
		return nil, false, apperrors.Wrap("VALIDATION", "attributes: максимум 3 атрибута", nil)
	}
	total := 1
	for _, attr := range a.Attributes {
		if strings.TrimSpace(attr.Name) == "" {
			return nil, false, apperrors.Wrap("VALIDATION", "attributes: атрибут без имени", nil)
		}
		if len(attr.Values) == 0 || len(attr.Values) > 10 {
			return nil, false, apperrors.Wrap("VALIDATION", "attributes: у атрибута должно быть 1–10 значений", nil)
		}
		seen := map[string]bool{}
		for _, v := range attr.Values {
			lv := strings.ToLower(strings.TrimSpace(v))
			if lv == "" {
				return nil, false, apperrors.Wrap("VALIDATION", "attributes: пустое значение", nil)
			}
			if seen[lv] {
				return nil, false, apperrors.Wrap("VALIDATION", "attributes: значение повторяется: "+v, nil)
			}
			seen[lv] = true
		}
		total *= len(attr.Values)
	}
	if total > 60 {
		return nil, false, apperrors.Wrap("VALIDATION", "attributes: слишком много комбинаций", nil)
	}
	// Полнота цен: комбинация без положительной цены сломает материализацию.
	prices := map[string]bool{}
	for _, c := range a.Combos {
		p, err := decimal.FromString(c.Price)
		if err != nil || !decimal.IsPositive(p) {
			return nil, false, apperrors.Wrap("VALIDATION", "attributes: цена комбинации должна быть положительной", nil)
		}
		prices[comboLabelKey(c.Labels)] = true
	}
	var walk func(idx int, labels []string) error
	walk = func(idx int, labels []string) error {
		if idx == len(a.Attributes) {
			if !prices[comboLabelKey(labels)] {
				return apperrors.Wrap("VALIDATION", "attributes: не задана цена комбинации: "+strings.Join(labels, " "), nil)
			}
			return nil
		}
		for _, v := range a.Attributes[idx].Values {
			if err := walk(idx+1, append(labels, strings.TrimSpace(v))); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(0, nil); err != nil {
		return nil, false, err
	}
	return &a, false, nil
}

// CreateNetworkMenuItem заводит блюдо в мастер-меню сети.
func (s *NetworkService) CreateNetworkMenuItem(ctx context.Context, in NetworkMenuInput) (*models.NetworkMenuItem, error) {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return nil, err
	}
	if in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	price := decimal.Zero
	if in.BasePrice != "" {
		if p, err := decimal.FromString(in.BasePrice); err == nil {
			price = decimal.Normalize(p)
		}
	}
	attrs, _, err := parseNetworkMenuAttrs(in.Attributes)
	if err != nil {
		return nil, err
	}
	available := true
	if in.Available != nil {
		available = *in.Available
	}
	now := time.Now().UTC()
	m := &models.NetworkMenuItem{
		ID: uuid.NewString(), AccountID: &account, Name: in.Name,
		Category: strPtrOrNil(in.Category), BasePrice: price,
		Station: strPtrOrNil(in.Station), Unit: strPtrOrNil(in.Unit), Emoji: strPtrOrNil(in.Emoji),
		Available: available, CreatedAt: now, UpdatedAt: now,
	}
	if attrs != nil {
		b, merr := json.Marshal(attrs)
		if merr != nil {
			return nil, merr
		}
		m.Attributes = datatypes.JSON(b)
	}
	if err := s.r.Raw().WithContext(ctx).Create(m).Error; err != nil {
		return nil, err
	}
	return m, nil
}

// UpdateNetworkMenuItem правит мастер-блюдо (в рамках своей сети).
func (s *NetworkService) UpdateNetworkMenuItem(ctx context.Context, id string, in NetworkMenuInput) (*models.NetworkMenuItem, error) {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return nil, err
	}
	patch := map[string]any{"updated_at": time.Now().UTC()}
	if in.Name != "" {
		patch["name"] = in.Name
	}
	patch["category"] = strPtrOrNil(in.Category)
	patch["station"] = strPtrOrNil(in.Station)
	patch["unit"] = strPtrOrNil(in.Unit)
	patch["emoji"] = strPtrOrNil(in.Emoji)
	if in.BasePrice != "" {
		if p, err := decimal.FromString(in.BasePrice); err == nil {
			patch["base_price"] = decimal.Normalize(p)
		}
	}
	attrs, clear, err := parseNetworkMenuAttrs(in.Attributes)
	if err != nil {
		return nil, err
	}
	if clear {
		patch["attributes"] = nil
	} else if attrs != nil {
		b, merr := json.Marshal(attrs)
		if merr != nil {
			return nil, merr
		}
		patch["attributes"] = datatypes.JSON(b)
	}
	res := s.r.Raw().WithContext(ctx).Model(&models.NetworkMenuItem{}).
		Where("id = ? AND account_id = ?", id, account).Updates(patch)
	if res.Error != nil {
		return nil, res.Error
	}
	if res.RowsAffected == 0 {
		return nil, apperrors.ErrNotFound
	}
	var out models.NetworkMenuItem
	s.r.Raw().WithContext(ctx).Where("id = ?", id).First(&out)
	return &out, nil
}

// BranchSummary — строка сводки по филиалу.
type BranchSummary struct {
	ID      string          `json:"id"`
	Name    string          `json:"name"`
	Kind    *string         `json:"kind"`
	Revenue decimal.Decimal `json:"revenue"`
}

// NetworkSummary — сводка владельцу по сети (ADR-003, Фаза 4).
type NetworkSummary struct {
	From         string          `json:"from,omitempty"`
	To           string          `json:"to,omitempty"`
	TotalRevenue decimal.Decimal `json:"total_revenue"`
	Branches     []BranchSummary `json:"branches"`
}

// branchesForAccount — все рестораны сети account, central_warehouse первым
// (используется Summary + сетевыми отчётами Ф8: PnL/Cashflow/Warehouse/Accounts —
// единая точка запроса списка филиалов, чтобы порядок и состав не разъезжались
// между эндпоинтами).
func (s *NetworkService) branchesForAccount(ctx context.Context, account string) ([]models.Restaurant, error) {
	var branches []models.Restaurant
	// Явный CASE, а не `kind DESC`: последний обещанного порядка НЕ давал —
	// алфавитно 'central_warehouse' < 'outlet', поэтому DESC ставил первыми
	// как раз филиалы, а строки с kind = NULL (ресторан в сети, но роль не
	// назначена) в DESC идут вообще впереди всех (NULLS FIRST — умолчание
	// Postgres для DESC). Расхождение с комментарием было косметическим:
	// фронт сортирует сводку сам (по выручке/балансу), но «Персонал сети»
	// (Фаза П) показывает филиалы именно в этом порядке.
	if err := s.r.Raw().WithContext(ctx).
		Where("account_id = ?", account).
		Order("CASE WHEN kind = 'central_warehouse' THEN 0 ELSE 1 END, name ASC").
		Find(&branches).Error; err != nil {
		return nil, err
	}
	return branches, nil
}

// branchIDs — id'шники филиалов, для WHERE restaurant_id IN (...).
func branchIDs(branches []models.Restaurant) []string {
	ids := make([]string, len(branches))
	for i, b := range branches {
		ids[i] = b.ID
	}
	return ids
}

// Summary — выручка по сети и по каждому филиалу за период (ADR-003, Фаза 4).
// Источник — financial_operations(type=in, category=revenue). На центральном
// узле они собраны со всех филиалов через sync; в однобазовом режиме — там же.
//
// financial_operations не имеет account_id, поэтому фильтруем по restaurant_id
// IN (<филиалы сети>) — сетевой доступ к per-restaurant таблице (Raw, легитимно).
func (s *NetworkService) Summary(ctx context.Context, from, to string) (*NetworkSummary, error) {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return nil, err
	}
	branches, err := s.branchesForAccount(ctx, account)
	if err != nil {
		return nil, err
	}
	ids := branchIDs(branches)

	// Выручка по филиалам за период.
	revByRest := make(map[string]decimal.Decimal, len(ids))
	if len(ids) > 0 {
		type revRow struct {
			RestaurantID string
			Revenue      decimal.Decimal
		}
		q := s.r.Raw().WithContext(ctx).
			Model(&models.FinancialOperation{}).
			Select("restaurant_id, COALESCE(SUM(amount), 0) AS revenue").
			Where("restaurant_id IN ? AND type = ? AND category = ?", ids, "in", "revenue")
		if from != "" {
			q = q.Where("created_at >= ?", from)
		}
		if to != "" {
			q = q.Where("created_at <= ?", to)
		}
		var rows []revRow
		if err := q.Group("restaurant_id").Find(&rows).Error; err != nil {
			return nil, err
		}
		for _, r := range rows {
			revByRest[r.RestaurantID] = decimal.Normalize(r.Revenue)
		}
	}

	out := &NetworkSummary{From: from, To: to, TotalRevenue: decimal.Zero}
	for _, b := range branches {
		rev := revByRest[b.ID]
		out.Branches = append(out.Branches, BranchSummary{ID: b.ID, Name: b.Name, Kind: b.Kind, Revenue: rev})
		out.TotalRevenue = decimal.Add(out.TotalRevenue, rev)
	}
	out.TotalRevenue = decimal.Normalize(out.TotalRevenue)
	return out, nil
}
