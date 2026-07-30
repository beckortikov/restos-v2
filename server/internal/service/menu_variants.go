package service

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// Товары с атрибутами («Fanta» × Размер {1 л, 1.5 л}).
//
// Продукт-родитель (parent_id IS NULL) хранит атрибуты и их значения;
// продаваемые комбинации — обычные menu_items с parent_id=продукт, у каждой
// свой price/техкарта/складской SKU. PUT /menu/items/{id}/attributes
// декларативно синхронизирует атрибуты и генерирует/архивирует варианты.
//
// Цены задаются per-комбинация (combos[] в PUT): значение атрибута — чистый
// лейбл. Цена/закупка комбинации живут на строке варианта (price/cogs +
// price_per_unit его ингредиента). PATCH имени родителя переименовывает
// варианты (recomputeVariants), цены при этом не трогаются.

const (
	maxAttributesPerItem = 3
	maxValuesPerAttr     = 10
	maxVariantsPerItem   = 60
)

// MenuAttributeValueInput — значение атрибута в PUT-запросе (чистый лейбл).
type MenuAttributeValueInput struct {
	ID    *string `json:"id,omitempty"`
	Label string  `json:"label"`
}

// ComboPriceInput — цена конкретной комбинации. Labels — лейблы значений в
// порядке атрибутов (["1 л", "Виноград"]).
type ComboPriceInput struct {
	Labels []string `json:"labels"`
	Price  *string  `json:"price,omitempty"` // decimal as string
	// PurchasePrice — закупка (покупные товары): идёт в price_per_unit
	// складского ингредиента варианта и его cogs.
	PurchasePrice *string `json:"purchase_price,omitempty"`
}

// comboPrice — распарсенные цены комбинации.
type comboPrice struct {
	price    decimal.Decimal
	purchase decimal.Decimal
}

// MenuAttributeInput — атрибут в PUT-запросе. Порядок массивов = sort_order.
// SizeScaleID переключает атрибут в режим «значения из шкалы размеров»:
// Values в этом случае должен быть пустым — значения зеркалятся из шкалы
// сервисом (см. syncAttributeDefs), а не приходят от клиента.
type MenuAttributeInput struct {
	ID          *string                   `json:"id,omitempty"`
	Name        string                    `json:"name"`
	Values      []MenuAttributeValueInput `json:"values"`
	SizeScaleID *string                   `json:"size_scale_id,omitempty"`
}

// SyncAttributesInput — body PUT /menu/items/{id}/attributes.
// Пустой attributes → продукт снова становится обычным блюдом
// (атрибуты удаляются, варианты архивируются).
type SyncAttributesInput struct {
	Attributes []MenuAttributeInput `json:"attributes"`
	// Combos — цены всех комбинаций (декартово произведение значений).
	Combos []ComboPriceInput `json:"combos,omitempty"`
}

// MenuAttributeWithValues — атрибут + значения (DTO ответа).
type MenuAttributeWithValues struct {
	models.MenuAttribute
	Values []models.MenuAttributeValue `json:"values"`
}

// MenuVariantDTO — вариант + id значений его комбинации.
type MenuVariantDTO struct {
	models.MenuItem
	ValueIDs []string `json:"value_ids"`
}

// ProductAttributesState — полное состояние продукта: атрибуты + варианты.
type ProductAttributesState struct {
	Attributes []MenuAttributeWithValues `json:"attributes"`
	Variants   []MenuVariantDTO          `json:"variants"`
}

// GetAttributes — GET /menu/items/{id}/attributes.
func (s *MenuService) GetAttributes(ctx context.Context, productID string) (*ProductAttributesState, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var product models.MenuItem
	if err := scoped.Where("id = ?", productID).First(&product).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	state := &ProductAttributesState{
		Attributes: []MenuAttributeWithValues{},
		Variants:   []MenuVariantDTO{},
	}

	scopedA, _ := s.r.ForTenant(ctx)
	var attrs []models.MenuAttribute
	if err := scopedA.Where("menu_item_id = ?", productID).
		Order("sort_order ASC, created_at ASC").Find(&attrs).Error; err != nil {
		return nil, err
	}
	if len(attrs) > 0 {
		attrIDs := make([]string, 0, len(attrs))
		for _, a := range attrs {
			attrIDs = append(attrIDs, a.ID)
		}
		scopedV, _ := s.r.ForTenant(ctx)
		var vals []models.MenuAttributeValue
		if err := scopedV.Where("attribute_id IN ?", attrIDs).
			Order("sort_order ASC, created_at ASC").Find(&vals).Error; err != nil {
			return nil, err
		}
		valsByAttr := map[string][]models.MenuAttributeValue{}
		for _, v := range vals {
			valsByAttr[v.AttributeID] = append(valsByAttr[v.AttributeID], v)
		}
		for _, a := range attrs {
			vs := valsByAttr[a.ID]
			if vs == nil {
				vs = []models.MenuAttributeValue{}
			}
			state.Attributes = append(state.Attributes, MenuAttributeWithValues{MenuAttribute: a, Values: vs})
		}
	}

	scopedVar, _ := s.r.ForTenant(ctx)
	var variants []models.MenuItem
	if err := scopedVar.Where("parent_id = ? AND is_deleted = ?", productID, false).
		Order("created_at ASC").Find(&variants).Error; err != nil {
		return nil, err
	}
	if len(variants) > 0 {
		ids := make([]string, 0, len(variants))
		for _, v := range variants {
			ids = append(ids, v.ID)
		}
		scopedL, _ := s.r.ForTenant(ctx)
		var links []models.MenuItemVariantValue
		if err := scopedL.Where("menu_item_id IN ?", ids).Find(&links).Error; err != nil {
			return nil, err
		}
		linksByItem := map[string][]string{}
		for _, l := range links {
			linksByItem[l.MenuItemID] = append(linksByItem[l.MenuItemID], l.ValueID)
		}
		for _, v := range variants {
			vids := linksByItem[v.ID]
			if vids == nil {
				vids = []string{}
			}
			sort.Strings(vids)
			state.Variants = append(state.Variants, MenuVariantDTO{MenuItem: v, ValueIDs: vids})
		}
	}
	return state, nil
}

// syncedValue — значение после синка определений (для генерации комбинаций).
type syncedValue struct {
	ID    string
	Label string
}

// SyncAttributes — PUT /menu/items/{id}/attributes. Всё в одной транзакции:
// определения атрибутов/значений приводятся к payload'у (создание/переименование/
// удаление), затем декартово произведение значений сверяется с вариантами:
// недостающие создаются (или воскрешаются по имени из архива — сохраняет
// складской SKU покупного товара), лишние — soft-delete.
func (s *MenuService) SyncAttributes(ctx context.Context, productID string, in SyncAttributesInput) (*ProductAttributesState, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if err := validateAttributesInput(in); err != nil {
		return nil, err
	}

	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var product models.MenuItem
	if err := scoped.Where("id = ? AND is_deleted = ?", productID, false).First(&product).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	if product.ParentID != nil {
		return nil, apperrors.Wrap("VALIDATION", "вариант не может иметь собственных атрибутов", nil)
	}

	prices := map[string]comboPrice{}
	if len(in.Attributes) > 0 {
		var perr error
		if prices, perr = parsePricesMap(in); perr != nil {
			return nil, perr
		}
	}

	txErr := s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		orderedAttrs, err := syncAttributeDefs(tx, rid, productID, in)
		if err != nil {
			return err
		}
		// Полнота комбинаций проверяется здесь, а не в validateAttributesInput:
		// для scale-linked атрибутов количество/лейблы значений известны только
		// после того, как syncAttributeDefs зеркалит их из шкалы размеров.
		if err := validateComboCount(orderedAttrs); err != nil {
			return err
		}
		if len(in.Attributes) > 0 {
			if err := validateComboCompleteness(orderedAttrs, prices); err != nil {
				return err
			}
		}
		return s.syncVariants(tx, rid, &product, orderedAttrs, prices)
	})
	if txErr != nil {
		return nil, txErr
	}
	return s.GetAttributes(ctx, productID)
}

func validateAttributesInput(in SyncAttributesInput) error {
	if len(in.Attributes) > maxAttributesPerItem {
		return apperrors.Wrap("VALIDATION", "максимум 3 атрибута на товар", nil)
	}
	seenNames := map[string]bool{}
	for _, a := range in.Attributes {
		name := strings.TrimSpace(a.Name)
		if name == "" {
			return apperrors.Wrap("VALIDATION", "название атрибута не может быть пустым", nil)
		}
		key := strings.ToLower(name)
		if seenNames[key] {
			return apperrors.Wrap("VALIDATION", "атрибуты не могут повторяться: "+name, nil)
		}
		seenNames[key] = true

		// Scale-linked: значения зеркалятся из шкалы (syncAttributeDefs), а не
		// приходят от клиента — состав/количество проверяются после синка.
		if a.SizeScaleID != nil && *a.SizeScaleID != "" {
			if len(a.Values) > 0 {
				return apperrors.Wrap("VALIDATION", "атрибут «"+name+"»: значения задаются шкалой размеров, values должен быть пустым", nil)
			}
			continue
		}

		if len(a.Values) == 0 {
			return apperrors.Wrap("VALIDATION", "у атрибута «"+name+"» нет ни одного значения", nil)
		}
		if len(a.Values) > maxValuesPerAttr {
			return apperrors.Wrap("VALIDATION", "максимум 10 значений на атрибут", nil)
		}
		seenLabels := map[string]bool{}
		for _, v := range a.Values {
			label := strings.TrimSpace(v.Label)
			if label == "" {
				return apperrors.Wrap("VALIDATION", "значение атрибута не может быть пустым", nil)
			}
			lk := strings.ToLower(label)
			if seenLabels[lk] {
				return apperrors.Wrap("VALIDATION", "значения атрибута «"+name+"» не могут повторяться: "+label, nil)
			}
			seenLabels[lk] = true
		}
	}
	return nil
}

// validateComboCount ограничивает число комбинаций (=произведение количества
// значений по атрибутам) после того, как значения scale-linked атрибутов уже
// разрешены из шкалы — до этого их количество неизвестно.
func validateComboCount(orderedAttrs [][]syncedValue) error {
	combos := 1
	for _, vals := range orderedAttrs {
		combos *= len(vals)
	}
	if combos > maxVariantsPerItem {
		return apperrors.Wrap("VALIDATION", "слишком много комбинаций (максимум 60)", nil)
	}
	return nil
}

// validateComboCompleteness требует цену (> 0) для КАЖДОЙ комбинации
// декартова произведения уже разрешённых значений (orderedAttrs), а не
// исходных лейблов из payload'а — единообразно для freehand и scale-linked.
func validateComboCompleteness(orderedAttrs [][]syncedValue, prices map[string]comboPrice) error {
	if len(orderedAttrs) == 0 {
		return nil
	}
	for _, combo := range cartesian(orderedAttrs) {
		labels := make([]string, 0, len(combo))
		for _, v := range combo {
			labels = append(labels, v.Label)
		}
		cp, ok := prices[comboLabelKey(labels)]
		if !ok || !cp.price.IsPositive() {
			return apperrors.Wrap("VALIDATION", "не задана цена комбинации: "+strings.Join(labels, " "), nil)
		}
	}
	return nil
}

// comboLabelKey — ключ комбинации по лейблам в порядке атрибутов.
func comboLabelKey(labels []string) string {
	trimmed := make([]string, 0, len(labels))
	for _, l := range labels {
		trimmed = append(trimmed, strings.TrimSpace(l))
	}
	return strings.Join(trimmed, "\x1f")
}

// parsePricesMap парсит combos[] в map по ключу лейблов. Полнота покрытия
// (цена на каждую комбинацию) проверяется отдельно, validateComboCompleteness,
// после того как значения атрибутов разрешены (см. SyncAttributes).
func parsePricesMap(in SyncAttributesInput) (map[string]comboPrice, error) {
	prices := make(map[string]comboPrice, len(in.Combos))
	for _, c := range in.Combos {
		key := comboLabelKey(c.Labels)
		cp := comboPrice{price: decimal.Zero, purchase: decimal.Zero}
		if c.Price != nil {
			pr, err := decimal.FromString(*c.Price)
			if err != nil {
				return nil, apperrors.Wrap("VALIDATION", "bad combo price", err)
			}
			if decimal.IsNegative(pr) {
				return nil, apperrors.Wrap("VALIDATION", "combo price must be >= 0", nil)
			}
			cp.price = pr
		}
		if c.PurchasePrice != nil {
			pp, err := decimal.FromString(*c.PurchasePrice)
			if err != nil {
				return nil, apperrors.Wrap("VALIDATION", "bad combo purchase_price", err)
			}
			if decimal.IsNegative(pp) {
				return nil, apperrors.Wrap("VALIDATION", "combo purchase_price must be >= 0", nil)
			}
			cp.purchase = pp
		}
		prices[key] = cp
	}
	return prices, nil
}

// syncAttributeDefs приводит menu_attributes/menu_attribute_values к payload'у.
// Возвращает атрибуты в порядке payload'а со значениями в порядке payload'а.
func syncAttributeDefs(tx *gorm.DB, rid, productID string, in SyncAttributesInput) ([][]syncedValue, error) {
	now := time.Now().UTC()

	var existing []models.MenuAttribute
	if err := tx.Where("restaurant_id = ? AND menu_item_id = ?", rid, productID).
		Find(&existing).Error; err != nil {
		return nil, err
	}
	existingByID := map[string]models.MenuAttribute{}
	for _, a := range existing {
		existingByID[a.ID] = a
	}

	keptAttrIDs := map[string]bool{}
	orderedAttrIDs := make([]string, 0, len(in.Attributes))
	for i, ain := range in.Attributes {
		name := strings.TrimSpace(ain.Name)
		if ain.ID != nil {
			if _, ok := existingByID[*ain.ID]; !ok {
				return nil, apperrors.Wrap("VALIDATION", "attribute id не принадлежит товару", nil)
			}
			if err := tx.Model(&models.MenuAttribute{}).
				Where("id = ?", *ain.ID).
				Updates(map[string]any{"name": name, "sort_order": i, "size_scale_id": ain.SizeScaleID, "updated_at": now}).Error; err != nil {
				return nil, err
			}
			keptAttrIDs[*ain.ID] = true
			orderedAttrIDs = append(orderedAttrIDs, *ain.ID)
			continue
		}
		a := &models.MenuAttribute{
			ID: uuid.NewString(), MenuItemID: productID, Name: name,
			SortOrder: i, SizeScaleID: ain.SizeScaleID, RestaurantID: &rid, CreatedAt: now, UpdatedAt: now,
		}
		if err := tx.Create(a).Error; err != nil {
			return nil, err
		}
		keptAttrIDs[a.ID] = true
		orderedAttrIDs = append(orderedAttrIDs, a.ID)
	}
	for _, a := range existing {
		if !keptAttrIDs[a.ID] {
			// CASCADE удалит значения и связки вариантов.
			if err := tx.Delete(&models.MenuAttribute{}, "id = ?", a.ID).Error; err != nil {
				return nil, err
			}
		}
	}

	// Значения — тем же диффом внутри каждого атрибута.
	var existingVals []models.MenuAttributeValue
	if len(orderedAttrIDs) > 0 {
		if err := tx.Where("attribute_id IN ?", orderedAttrIDs).Find(&existingVals).Error; err != nil {
			return nil, err
		}
	}
	existingValByID := map[string]models.MenuAttributeValue{}
	for _, v := range existingVals {
		existingValByID[v.ID] = v
	}

	// Зеркала scale-linked значений уже присутствующих у атрибута (для find-or-
	// create по size_scale_value_id, вместо диффа по client-supplied id).
	mirrorsByAttr := map[string]map[string]models.MenuAttributeValue{}
	for _, v := range existingVals {
		if v.SizeScaleValueID == nil {
			continue
		}
		if mirrorsByAttr[v.AttributeID] == nil {
			mirrorsByAttr[v.AttributeID] = map[string]models.MenuAttributeValue{}
		}
		mirrorsByAttr[v.AttributeID][*v.SizeScaleValueID] = v
	}

	orderedAttrs := make([][]syncedValue, 0, len(in.Attributes))
	keptValIDs := map[string]bool{}
	for ai, ain := range in.Attributes {
		attrID := orderedAttrIDs[ai]

		if ain.SizeScaleID != nil && *ain.SizeScaleID != "" {
			vals, err := syncScaleLinkedValues(tx, rid, attrID, *ain.SizeScaleID, mirrorsByAttr[attrID], now, keptValIDs)
			if err != nil {
				return nil, err
			}
			orderedAttrs = append(orderedAttrs, vals)
			continue
		}

		vals := make([]syncedValue, 0, len(ain.Values))
		for vi, vin := range ain.Values {
			label := strings.TrimSpace(vin.Label)
			if vin.ID != nil {
				ev, ok := existingValByID[*vin.ID]
				if !ok || ev.AttributeID != attrID {
					return nil, apperrors.Wrap("VALIDATION", "value id не принадлежит атрибуту", nil)
				}
				if err := tx.Model(&models.MenuAttributeValue{}).
					Where("id = ?", *vin.ID).
					Updates(map[string]any{
						"label": label, "sort_order": vi, "updated_at": now,
					}).Error; err != nil {
					return nil, err
				}
				keptValIDs[*vin.ID] = true
				vals = append(vals, syncedValue{ID: *vin.ID, Label: label})
				continue
			}
			v := &models.MenuAttributeValue{
				ID: uuid.NewString(), AttributeID: attrID, Label: label,
				SortOrder: vi, RestaurantID: &rid,
				CreatedAt: now, UpdatedAt: now,
			}
			if err := tx.Create(v).Error; err != nil {
				return nil, err
			}
			keptValIDs[v.ID] = true
			vals = append(vals, syncedValue{ID: v.ID, Label: label})
		}
		orderedAttrs = append(orderedAttrs, vals)
	}
	for _, v := range existingVals {
		if !keptValIDs[v.ID] {
			if err := tx.Delete(&models.MenuAttributeValue{}, "id = ?", v.ID).Error; err != nil {
				return nil, err
			}
		}
	}
	return orderedAttrs, nil
}

// syncScaleLinkedValues зеркалит значения шкалы размеров в menu_attribute_values
// атрибута: find-or-create по size_scale_value_id (не по client id — клиент не
// присылает values для scale-linked атрибута вовсе, см. validateAttributesInput).
// Лейбл — Title шкалы, если задан, иначе Code («25»).
func syncScaleLinkedValues(tx *gorm.DB, rid, attrID, scaleID string, mirrors map[string]models.MenuAttributeValue, now time.Time, keptValIDs map[string]bool) ([]syncedValue, error) {
	var scaleValues []models.SizeScaleValue
	if err := tx.Where("restaurant_id = ? AND size_scale_id = ?", rid, scaleID).
		Order("sort_order ASC, created_at ASC").Find(&scaleValues).Error; err != nil {
		return nil, err
	}
	if len(scaleValues) == 0 {
		return nil, apperrors.Wrap("VALIDATION", "у выбранной шкалы размеров нет значений", nil)
	}

	vals := make([]syncedValue, 0, len(scaleValues))
	for vi, sv := range scaleValues {
		label := sv.Code
		if sv.Title != nil && strings.TrimSpace(*sv.Title) != "" {
			label = *sv.Title
		}
		if m, ok := mirrors[sv.ID]; ok {
			if err := tx.Model(&models.MenuAttributeValue{}).
				Where("id = ?", m.ID).
				Updates(map[string]any{"label": label, "sort_order": vi, "updated_at": now}).Error; err != nil {
				return nil, err
			}
			keptValIDs[m.ID] = true
			vals = append(vals, syncedValue{ID: m.ID, Label: label})
			continue
		}
		svID := sv.ID
		v := &models.MenuAttributeValue{
			ID: uuid.NewString(), AttributeID: attrID, Label: label,
			SortOrder: vi, SizeScaleValueID: &svID, RestaurantID: &rid,
			CreatedAt: now, UpdatedAt: now,
		}
		if err := tx.Create(v).Error; err != nil {
			return nil, err
		}
		keptValIDs[v.ID] = true
		vals = append(vals, syncedValue{ID: v.ID, Label: label})
	}
	return vals, nil
}

// comboKey — стабильный ключ комбинации: sorted value ids joined.
func comboKey(valueIDs []string) string {
	ids := append([]string(nil), valueIDs...)
	sort.Strings(ids)
	return strings.Join(ids, ",")
}

// variantName — «Fanta 1 л» / «Fanta Виноград 1 л».
func variantName(base string, combo []syncedValue) string {
	parts := make([]string, 0, len(combo)+1)
	parts = append(parts, base)
	for _, v := range combo {
		parts = append(parts, v.Label)
	}
	return strings.Join(parts, " ")
}

// cartesian — все комбинации значений в порядке атрибутов.
func cartesian(attrs [][]syncedValue) [][]syncedValue {
	combos := [][]syncedValue{{}}
	for _, vals := range attrs {
		next := make([][]syncedValue, 0, len(combos)*len(vals))
		for _, c := range combos {
			for _, v := range vals {
				cc := append(append([]syncedValue(nil), c...), v)
				next = append(next, cc)
			}
		}
		combos = next
	}
	return combos
}

// syncVariants сверяет варианты с декартовым произведением значений.
// prices — цены комбинаций по лейблам; отсутствие записи (например при
// recomputeVariants после переименования продукта) сохраняет текущую цену.
func (s *MenuService) syncVariants(tx *gorm.DB, rid string, product *models.MenuItem, orderedAttrs [][]syncedValue, prices map[string]comboPrice) error {
	now := time.Now().UTC()
	baseName := ""
	if product.Name != nil {
		baseName = *product.Name
	}

	// Все варианты продукта, включая архивные (для воскрешения по имени).
	var variants []models.MenuItem
	if err := tx.Where("restaurant_id = ? AND parent_id = ?", rid, product.ID).
		Find(&variants).Error; err != nil {
		return err
	}
	variantIDs := make([]string, 0, len(variants))
	for _, v := range variants {
		variantIDs = append(variantIDs, v.ID)
	}
	var links []models.MenuItemVariantValue
	if len(variantIDs) > 0 {
		if err := tx.Where("menu_item_id IN ?", variantIDs).Find(&links).Error; err != nil {
			return err
		}
	}
	linksByItem := map[string][]string{}
	for _, l := range links {
		linksByItem[l.MenuItemID] = append(linksByItem[l.MenuItemID], l.ValueID)
	}

	liveByKey := map[string]*models.MenuItem{}
	deletedByName := map[string]*models.MenuItem{}
	for i := range variants {
		v := &variants[i]
		if v.IsDeleted {
			if v.Name != nil {
				deletedByName[*v.Name] = v
			}
			continue
		}
		liveByKey[comboKey(linksByItem[v.ID])] = v
	}

	combos := [][]syncedValue{}
	if len(orderedAttrs) > 0 {
		combos = cartesian(orderedAttrs)
	}

	matched := map[string]bool{}
	for _, combo := range combos {
		ids := make([]string, 0, len(combo))
		for _, v := range combo {
			ids = append(ids, v.ID)
		}
		key := comboKey(ids)
		name := variantName(baseName, combo)
		labels := make([]string, 0, len(combo))
		for _, v := range combo {
			labels = append(labels, v.Label)
		}
		cp, hasPrice := prices[comboLabelKey(labels)]

		if v, ok := liveByKey[key]; ok {
			matched[v.ID] = true
			updates := map[string]any{}
			if v.Name == nil || *v.Name != name {
				updates["name"] = name
			}
			if hasPrice && !v.Price.Equal(cp.price) {
				updates["price"] = cp.price
			}
			if hasPrice && product.IsPurchased && cp.purchase.IsPositive() && !v.COGS.Equal(cp.purchase) {
				updates["cogs"] = cp.purchase
			}
			if len(updates) > 0 {
				updates["updated_at"] = now
				if err := tx.Model(&models.MenuItem{}).Where("id = ?", v.ID).Updates(updates).Error; err != nil {
					return err
				}
			}
			if hasPrice && product.IsPurchased && cp.purchase.IsPositive() {
				if err := syncVariantIngredientPrice(tx, rid, v.ID, cp.purchase); err != nil {
					return err
				}
			}
			continue
		}

		if v, ok := deletedByName[name]; ok && !matched[v.ID] {
			// Воскрешение: сохраняет складской SKU покупного и историю продаж.
			matched[v.ID] = true
			resUpdates := map[string]any{
				"is_deleted": false, "category": deref(product.Category),
				"updated_at": now,
			}
			if hasPrice {
				resUpdates["price"] = cp.price
				if product.IsPurchased && cp.purchase.IsPositive() {
					resUpdates["cogs"] = cp.purchase
				}
			}
			if err := tx.Model(&models.MenuItem{}).Where("id = ?", v.ID).Updates(resUpdates).Error; err != nil {
				return err
			}
			if hasPrice && product.IsPurchased && cp.purchase.IsPositive() {
				if err := syncVariantIngredientPrice(tx, rid, v.ID, cp.purchase); err != nil {
					return err
				}
			}
			if err := tx.Where("menu_item_id = ?", v.ID).Delete(&models.MenuItemVariantValue{}).Error; err != nil {
				return err
			}
			if err := insertVariantLinks(tx, rid, v.ID, ids, now); err != nil {
				return err
			}
			continue
		}

		newID, err := s.createVariant(tx, rid, product, name, cp.price, cp.purchase, now)
		if err != nil {
			return err
		}
		matched[newID] = true
		if err := insertVariantLinks(tx, rid, newID, ids, now); err != nil {
			return err
		}
	}

	// Живые варианты без комбинации — в архив.
	for i := range variants {
		v := &variants[i]
		if v.IsDeleted || matched[v.ID] {
			continue
		}
		if err := tx.Model(&models.MenuItem{}).Where("id = ?", v.ID).
			Updates(map[string]any{"is_deleted": true, "updated_at": now}).Error; err != nil {
			return err
		}
	}

	// Покупной продукт с вариациями: у каждого варианта — свой склад, у родителя
	// нет. createVariant уже завёл ингредиенты новым вариантам; здесь досоздаём
	// пропущенные (напр. вариации, жившие до конвертации в покупной) и снимаем
	// фантом-ингредиент родителя, который создал CreateItem до знания об атрибутах.
	if product.IsPurchased && len(combos) > 0 {
		unitHint := parentBackingUnit(tx, rid, product.ID)
		if err := s.ensureVariantsPurchasedBacking(tx, rid, product, unitHint, product.COGS, now); err != nil {
			return err
		}
	}

	// Финальный снапшот: родитель + ВСЕ его варианты в текущем (пост-sync)
	// состоянии — один проход вместо инструментирования каждого Updates()
	// внутри циклов выше (создание/воскрешение/переименование/архивация).
	var allVariantIDs []string
	if err := tx.Model(&models.MenuItem{}).
		Where("restaurant_id = ? AND parent_id = ?", rid, product.ID).
		Pluck("id", &allVariantIDs).Error; err != nil {
		return err
	}
	return recordMenuItemsSync(tx, append(allVariantIDs, product.ID))
}

// parentBackingUnit — единица backing-ингредиента продукта (для наследования
// вариациями). Пусто → вызывающий подставит дефолт.
func parentBackingUnit(tx *gorm.DB, rid, productID string) string {
	var lines []models.TechCardLine
	if err := tx.Where("restaurant_id = ? AND menu_item_id = ?", rid, productID).Find(&lines).Error; err != nil {
		return ""
	}
	if len(lines) != 1 || lines[0].IngredientID == nil {
		return ""
	}
	var ing models.Ingredient
	if err := tx.Where("id = ?", *lines[0].IngredientID).First(&ing).Error; err != nil {
		return ""
	}
	if ing.Unit != nil {
		return *ing.Unit
	}
	return ""
}

// ensureVariantsPurchasedBacking гарантирует складской учёт покупного товара с
// вариациями «по-вариантно»: у КАЖДОЙ живой вариации — свой ингредиент на складе
// «Покупные» (0 остаток) + 1:1 техкарта, сама вариация помечена is_purchased.
// Родительский backing-ингредиент (фантом «Кола») снимается — продукт с
// вариациями напрямую не продаётся, склад под него не нужен.
//
// Идемпотентна: у вариации с готовым 1:1 покупным ингредиентом только
// подтверждает склад/флаг, не плодит дубликаты. Вызывается из patchPurchased
// (конвертация существующего блюда) и syncVariants (создание/досоздание
// вариаций у покупного продукта).
//
// unitHint / priceFallback — единица и закупка для ВНОВЬ создаваемых
// ингредиентов, если у вариации нет своей (cogs<=0).
func (s *MenuService) ensureVariantsPurchasedBacking(tx *gorm.DB, rid string, product *models.MenuItem, unitHint string, priceFallback decimal.Decimal, now time.Time) error {
	wid, err := resolveWarehouseID(tx, rid, false, true)
	if err != nil {
		return err
	}
	var variants []models.MenuItem
	if err := tx.Where("restaurant_id = ? AND parent_id = ? AND is_deleted = ?", rid, product.ID, false).
		Find(&variants).Error; err != nil {
		return err
	}
	if len(variants) == 0 {
		return nil // нет вариаций — этот путь не про нас
	}
	if unitHint == "" {
		unitHint = "шт"
	}
	for i := range variants {
		v := &variants[i]
		nm := ""
		if v.Name != nil {
			nm = *v.Name
		}
		price := v.COGS
		if !price.IsPositive() {
			price = priceFallback
		}
		var lines []models.TechCardLine
		if err := tx.Where("restaurant_id = ? AND menu_item_id = ?", rid, v.ID).Find(&lines).Error; err != nil {
			return err
		}
		if len(lines) == 1 && lines[0].IngredientID != nil {
			// Уже есть 1:1 backing — только подтверждаем склад «Покупные».
			if wid != nil {
				if err := tx.Model(&models.Ingredient{}).Where("id = ?", *lines[0].IngredientID).
					Update("warehouse_id", *wid).Error; err != nil {
					return err
				}
			}
		} else {
			// Нет своего склада (обычная вариация до конвертации) — создаём
			// ингредиент и заменяем техкарту на 1:1, как у одиночного покупного.
			ing := &models.Ingredient{
				ID: uuid.NewString(), Name: &nm, Category: product.Category,
				Qty: decimal.Zero, MinQty: decimal.Zero, Unit: &unitHint, PricePerUnit: price,
				WarehouseID: wid, RestaurantID: &rid,
			}
			if err := tx.Create(ing).Error; err != nil {
				return err
			}
			if err := tx.Where("menu_item_id = ?", v.ID).Delete(&models.TechCardLine{}).Error; err != nil {
				return err
			}
			line := &models.TechCardLine{
				ID: uuid.NewString(), MenuItemID: &v.ID, IngredientID: &ing.ID,
				Name: &nm, Qty: decimal.MustFromString("1"), Unit: &unitHint, RestaurantID: &rid,
			}
			if err := tx.Create(line).Error; err != nil {
				return err
			}
		}
		// Вариация покупного продукта — тоже покупная (иначе POS/склад считают её
		// готовящимся блюдом). cogs проставляем, если своей закупки не было.
		vUpd := map[string]any{"updated_at": now}
		if !v.IsPurchased {
			vUpd["is_purchased"] = true
		}
		if !v.COGS.IsPositive() && price.IsPositive() {
			vUpd["cogs"] = price
		}
		if len(vUpd) > 1 {
			if err := tx.Model(&models.MenuItem{}).Where("id = ?", v.ID).Updates(vUpd).Error; err != nil {
				return err
			}
		}
	}
	return removeParentPhantomBacking(tx, rid, product.ID)
}

// removeParentPhantomBacking снимает backing-ингредиент продукта-контейнера
// (у которого есть вариации): его создаёт CreateItem/patchPurchased до того, как
// узнаёт про атрибуты, а продаётся только вариант. Удаляем ТОЛЬКО безопасный
// фантом — пустой (qty 0) и без единого движения; со стоком/историей (была
// приёмка или начальный остаток) ингредиент оставляем как есть.
func removeParentPhantomBacking(tx *gorm.DB, rid, productID string) error {
	var lines []models.TechCardLine
	if err := tx.Where("restaurant_id = ? AND menu_item_id = ?", rid, productID).Find(&lines).Error; err != nil {
		return err
	}
	if len(lines) != 1 || lines[0].IngredientID == nil {
		return nil
	}
	ingID := *lines[0].IngredientID
	var ing models.Ingredient
	if err := tx.Where("id = ?", ingID).First(&ing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		return err
	}
	if ing.Qty.IsPositive() {
		return nil
	}
	var mvCount int64
	if err := tx.Model(&models.StockMovement{}).Where("ingredient_id = ?", ingID).Count(&mvCount).Error; err != nil {
		return err
	}
	if mvCount > 0 {
		return nil
	}
	if err := tx.Where("menu_item_id = ?", productID).Delete(&models.TechCardLine{}).Error; err != nil {
		return err
	}
	return tx.Where("id = ?", ingID).Delete(&models.Ingredient{}).Error
}

// syncVariantIngredientPrice обновляет закупку backing-ингредиента варианта
// (1:1 техкарта покупного) под Σ purchase_price значений его комбинации.
func syncVariantIngredientPrice(tx *gorm.DB, rid, variantID string, purchase decimal.Decimal) error {
	var lines []models.TechCardLine
	if err := tx.Where("restaurant_id = ? AND menu_item_id = ?", rid, variantID).
		Find(&lines).Error; err != nil {
		return err
	}
	if len(lines) != 1 || lines[0].IngredientID == nil {
		return nil
	}
	return tx.Model(&models.Ingredient{}).
		Where("id = ?", *lines[0].IngredientID).
		Update("price_per_unit", purchase).Error
}

func insertVariantLinks(tx *gorm.DB, rid, variantID string, valueIDs []string, now time.Time) error {
	for _, vid := range valueIDs {
		l := &models.MenuItemVariantValue{
			MenuItemID: variantID, ValueID: vid, RestaurantID: &rid,
			CreatedAt: now, UpdatedAt: now,
		}
		if err := tx.Create(l).Error; err != nil {
			return err
		}
	}
	return nil
}

// createVariant создаёт продаваемый вариант: копия полей продукта + своя цена.
// Покупной продукт → у варианта свой складской ингредиент (0 остаток) + 1:1
// техкарта (это отдельный SKU: бутылка 1 л ≠ бутылка 1.5 л). Обычное блюдо →
// копия техкарты продукта (дальше правится через /menu/tech-cards).
func (s *MenuService) createVariant(tx *gorm.DB, rid string, product *models.MenuItem, name string, price, purchase decimal.Decimal, now time.Time) (string, error) {
	nm := name
	v := &models.MenuItem{
		ID:                uuid.NewString(),
		Name:              &nm,
		Category:          product.Category,
		Price:             price,
		Emoji:             product.Emoji,
		ImageURL:          product.ImageURL,
		IsAvailable:       product.IsAvailable,
		IsPurchased:       product.IsPurchased,
		COGS:              product.COGS,
		CookTimeMin:       product.CookTimeMin,
		Station:           product.Station,
		IsBatchCooking:    product.IsBatchCooking,
		Unit:              product.Unit,
		UnitSize:          product.UnitSize,
		SaleStep:          product.SaleStep,
		LowStockThreshold: product.LowStockThreshold,
		ParentID:          &product.ID,
		RestaurantID:      &rid,
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	if err := tx.Create(v).Error; err != nil {
		return "", err
	}

	var productLines []models.TechCardLine
	if err := tx.Where("restaurant_id = ? AND menu_item_id = ?", rid, product.ID).
		Find(&productLines).Error; err != nil {
		return "", err
	}

	if product.IsPurchased {
		// Закупка варианта: Σ purchase_price его значений; если не задана —
		// наследуем от backing-ингредиента продукта. Единица и мин. остаток —
		// всегда от продукта («Закупочные данные»).
		unit := "шт"
		purchasePrice := purchase
		minQty := decimal.Zero
		if len(productLines) == 1 && productLines[0].IngredientID != nil {
			var parentIng models.Ingredient
			if err := tx.Where("id = ?", *productLines[0].IngredientID).First(&parentIng).Error; err == nil {
				if parentIng.Unit != nil {
					unit = *parentIng.Unit
				}
				if !purchasePrice.IsPositive() {
					purchasePrice = parentIng.PricePerUnit
				}
				minQty = parentIng.MinQty
			}
		}
		if !purchasePrice.IsPositive() {
			purchasePrice = product.COGS
		}
		if err := tx.Model(&models.MenuItem{}).Where("id = ?", v.ID).
			Update("cogs", purchasePrice).Error; err != nil {
			return "", err
		}
		// Мультисклад: складской товар варианта покупного блюда → «Покупные товары».
		wid, werr := resolveWarehouseID(tx, rid, false, true)
		if werr != nil {
			return "", werr
		}
		ing := &models.Ingredient{
			ID: uuid.NewString(), Name: &nm, Category: product.Category,
			Qty: decimal.Zero, MinQty: minQty, Unit: &unit, PricePerUnit: purchasePrice,
			WarehouseID: wid, RestaurantID: &rid,
		}
		if err := tx.Create(ing).Error; err != nil {
			return "", err
		}
		line := &models.TechCardLine{
			ID: uuid.NewString(), MenuItemID: &v.ID, IngredientID: &ing.ID,
			Name: &nm, Qty: decimal.MustFromString("1"), Unit: &unit, RestaurantID: &rid,
		}
		if err := tx.Create(line).Error; err != nil {
			return "", err
		}
		return v.ID, nil
	}

	for _, pl := range productLines {
		line := &models.TechCardLine{
			ID: uuid.NewString(), MenuItemID: &v.ID,
			IngredientID: pl.IngredientID, SemiTypeID: pl.SemiTypeID,
			Name: pl.Name, Qty: pl.Qty, Unit: pl.Unit, RestaurantID: &rid,
		}
		if err := tx.Create(line).Error; err != nil {
			return "", err
		}
	}
	return v.ID, nil
}

// recomputeVariants пересинхронизирует живые варианты продукта после PATCH
// родителя: имя варианта наследует имя продукта. Цены вариантов от родителя
// не зависят (Σ цен значений). No-op для товаров без атрибутов.
func (s *MenuService) recomputeVariants(ctx context.Context, productID string) error {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return err
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	var cnt int64
	if err := scoped.Model(&models.MenuAttribute{}).
		Where("menu_item_id = ?", productID).Count(&cnt).Error; err != nil {
		return err
	}
	if cnt == 0 {
		return nil
	}
	scoped2, _ := s.r.ForTenant(ctx)
	var product models.MenuItem
	if err := scoped2.Where("id = ?", productID).First(&product).Error; err != nil {
		return err
	}
	state, err := s.GetAttributes(ctx, productID)
	if err != nil {
		return err
	}
	orderedAttrs := make([][]syncedValue, 0, len(state.Attributes))
	for _, a := range state.Attributes {
		vals := make([]syncedValue, 0, len(a.Values))
		for _, v := range a.Values {
			vals = append(vals, syncedValue{ID: v.ID, Label: v.Label})
		}
		orderedAttrs = append(orderedAttrs, vals)
	}
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		return s.syncVariants(tx, rid, &product, orderedAttrs, map[string]comboPrice{})
	})
}
