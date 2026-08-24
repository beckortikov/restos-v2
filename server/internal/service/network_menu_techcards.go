package service

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// ── Техкарты мастер-блюда сети (миграция 085) ───────────────────────────────
//
// Модель клиента: технолог сидит в центре — техкарты заводятся там и должны
// приезжать в филиалы, иначе на точках не работает ни списание склада при
// продаже, ни фудкост. Локальные id через сеть не ездят, поэтому снапшот
// адресует ингредиенты ТОЛЬКО через nomenclature_id (общий каталог сети,
// Фаза М), а полуфабрикаты — парой (имя, размер).
//
// Пересборка снапшота происходит на КАЖДОЙ правке строки техкарты
// (TechCardsService Create/Patch/Delete) — дёшево и не требует помнить про
// синк в каждом новом месте. На узле без строки мастера (филиал правит своё
// блюдо) UPDATE попадает в ноль строк и это штатно: авторитет — central.

// NetworkTechCards — форма network_menu_items.tech_cards.
type NetworkTechCards struct {
	// Cards: ключ "" — техкарта самого продукта, иначе comboLabelKey лейблов
	// варианта (в порядке атрибутов).
	Cards map[string][]NetworkTechCardLine `json:"cards"`
}

// NetworkTechCardLine — строка техкарты в снапшоте: либо ингредиент (Nom),
// либо полуфабрикат (Semi).
type NetworkTechCardLine struct {
	Nom   string           `json:"nom,omitempty"`  // nomenclature_id
	Semi  *NetworkSemiSpec `json:"semi,omitempty"` // полуфабрикат
	Name  string           `json:"name,omitempty"`
	Qty   string           `json:"qty"`
	Unit  string           `json:"unit,omitempty"`
	Price string           `json:"price,omitempty"` // цена источника — только для СОЗДАНИЯ ингредиента
}

// NetworkSemiSpec — описание полуфабриката, достаточное для его создания на
// филиале: сам тип + рецепт (одноуровневый: рецепт содержит только
// ингредиенты, вложенных полуфабрикатов в модели нет).
type NetworkSemiSpec struct {
	Name       string                  `json:"name"`
	Size       string                  `json:"size,omitempty"` // лейбл значения шкалы («30»)
	OutputUnit string                  `json:"output_unit,omitempty"`
	Yield      string                  `json:"yield,omitempty"`
	Recipe     []NetworkSemiRecipeLine `json:"recipe,omitempty"`
}

type NetworkSemiRecipeLine struct {
	Nom        string `json:"nom"`
	Name       string `json:"name,omitempty"`
	QtyPerUnit string `json:"qty_per_unit"`
	Unit       string `json:"unit,omitempty"`
	Price      string `json:"price,omitempty"`
}

// rebuildMasterTechCards пересобирает снапшот техкарт мастера из фактических
// строк продукта productID и его вариантов. Вызывать в ТОЙ ЖЕ транзакции, что
// и правка строки. Молча выходит, если блюдо не привязано к мастеру или строки
// мастера нет в этой БД (узел — не central).
//
// Ингредиент без сетевой номенклатуры каталогизируется на месте (создаётся
// запись + линкуется) — ровно как при первой отправке перемещением
// (CreateTransfer): требовать ручной привязки заранее значило бы молча терять
// строки техкарты на филиалах.
func rebuildMasterTechCards(tx *gorm.DB, rid, productID string) error {
	var product models.MenuItem
	if err := tx.Where("restaurant_id = ? AND id = ?", rid, productID).First(&product).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		return err
	}
	// Строка техкарты могла принадлежать варианту — мастер живёт на продукте.
	if product.ParentID != nil && *product.ParentID != "" {
		return rebuildMasterTechCards(tx, rid, *product.ParentID)
	}
	if product.MasterID == nil || *product.MasterID == "" {
		return nil
	}

	var rest models.Restaurant
	if err := tx.Where("id = ?", rid).First(&rest).Error; err != nil {
		return err
	}
	if rest.AccountID == nil || *rest.AccountID == "" {
		return nil
	}
	accountID := *rest.AccountID
	now := time.Now().UTC()

	// Ключи вариантов: лейблы комбинации в порядке атрибутов.
	labelKeyByItem, err := variantLabelKeys(tx, rid, productID)
	if err != nil {
		return err
	}
	itemIDs := make([]string, 0, len(labelKeyByItem)+1)
	itemIDs = append(itemIDs, productID)
	for id := range labelKeyByItem {
		itemIDs = append(itemIDs, id)
	}

	var lines []models.TechCardLine
	if err := tx.Where("restaurant_id = ? AND menu_item_id IN ?", rid, itemIDs).
		Order("created_at ASC").Find(&lines).Error; err != nil {
		return err
	}

	snap := NetworkTechCards{Cards: map[string][]NetworkTechCardLine{}}
	// Пустая техкарта продукта — тоже управляемое состояние («строк нет»),
	// поэтому ключи заводим заранее для всех позиций.
	snap.Cards[""] = []NetworkTechCardLine{}
	for _, key := range labelKeyByItem {
		snap.Cards[key] = []NetworkTechCardLine{}
	}

	for i := range lines {
		l := lines[i]
		key := ""
		if l.MenuItemID != nil && *l.MenuItemID != productID {
			key = labelKeyByItem[*l.MenuItemID]
		}
		out := NetworkTechCardLine{Qty: decimal.Normalize(l.Qty).String(), Unit: derefOr(l.Unit, ""), Name: derefOr(l.Name, "")}
		switch {
		case l.IngredientID != nil && *l.IngredientID != "":
			nomID, name, unit, price, err := ensureIngredientCataloged(tx, rid, accountID, *l.IngredientID, now)
			if err != nil {
				return err
			}
			if nomID == "" {
				continue // ингредиент исчез — строку не переносим
			}
			out.Nom, out.Name, out.Price = nomID, name, price
			if out.Unit == "" {
				out.Unit = unit
			}
		case l.SemiTypeID != nil && *l.SemiTypeID != "":
			spec, err := buildSemiSpec(tx, rid, accountID, *l.SemiTypeID, now)
			if err != nil {
				return err
			}
			if spec == nil {
				continue
			}
			out.Semi = spec
		default:
			continue
		}
		snap.Cards[key] = append(snap.Cards[key], out)
	}

	b, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	return tx.Model(&models.NetworkMenuItem{}).
		Where("id = ?", *product.MasterID).
		Updates(map[string]any{"tech_cards": datatypes.JSON(b), "updated_at": now}).Error
}

// variantLabelKeys — comboLabelKey для каждого живого варианта продукта.
func variantLabelKeys(tx *gorm.DB, rid, productID string) (map[string]string, error) {
	var attrs []models.MenuAttribute
	if err := tx.Where("restaurant_id = ? AND menu_item_id = ?", rid, productID).
		Order("sort_order ASC, created_at ASC").Find(&attrs).Error; err != nil {
		return nil, err
	}
	attrIdx := map[string]int{}
	attrIDs := make([]string, 0, len(attrs))
	for i, a := range attrs {
		attrIdx[a.ID] = i
		attrIDs = append(attrIDs, a.ID)
	}
	valInfo := map[string]struct {
		idx   int
		label string
	}{}
	if len(attrIDs) > 0 {
		var vals []models.MenuAttributeValue
		if err := tx.Where("attribute_id IN ?", attrIDs).Find(&vals).Error; err != nil {
			return nil, err
		}
		for _, v := range vals {
			valInfo[v.ID] = struct {
				idx   int
				label string
			}{attrIdx[v.AttributeID], v.Label}
		}
	}

	var variants []models.MenuItem
	if err := tx.Where("restaurant_id = ? AND parent_id = ? AND is_deleted = ?", rid, productID, false).
		Find(&variants).Error; err != nil {
		return nil, err
	}
	out := map[string]string{}
	if len(variants) == 0 {
		return out, nil
	}
	ids := make([]string, 0, len(variants))
	for _, v := range variants {
		ids = append(ids, v.ID)
	}
	var links []models.MenuItemVariantValue
	if err := tx.Where("menu_item_id IN ?", ids).Find(&links).Error; err != nil {
		return nil, err
	}
	labelsByItem := map[string][]string{}
	for _, v := range variants {
		labelsByItem[v.ID] = make([]string, len(attrs))
	}
	for _, l := range links {
		if info, ok := valInfo[l.ValueID]; ok {
			if labels, ok2 := labelsByItem[l.MenuItemID]; ok2 && info.idx < len(labels) {
				labels[info.idx] = info.label
			}
		}
	}
	for id, labels := range labelsByItem {
		complete := len(labels) > 0
		for _, l := range labels {
			if l == "" {
				complete = false
				break
			}
		}
		if complete {
			out[id] = comboLabelKey(labels)
		}
	}
	return out, nil
}

// ensureIngredientCataloged — nomenclature_id ингредиента; несвязанный
// каталогизируется на месте (как при первой отправке перемещением).
func ensureIngredientCataloged(tx *gorm.DB, rid, accountID, ingredientID string, now time.Time) (nomID, name, unit, price string, err error) {
	var ing models.Ingredient
	if err := tx.Where("restaurant_id = ? AND id = ?", rid, ingredientID).First(&ing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return "", "", "", "", nil
		}
		return "", "", "", "", err
	}
	name, unit = derefOr(ing.Name, ""), derefOr(ing.Unit, "")
	price = decimal.Normalize(ing.PricePerUnit).String()
	if ing.NomenclatureID != nil && *ing.NomenclatureID != "" {
		return *ing.NomenclatureID, name, unit, price, nil
	}
	nom := &models.Nomenclature{
		ID: uuid.NewString(), AccountID: &accountID, Name: name,
		Unit: ing.Unit, Category: ing.Category, CreatedAt: now, UpdatedAt: now,
	}
	if err := tx.Create(nom).Error; err != nil {
		return "", "", "", "", err
	}
	if err := tx.Model(&models.Ingredient{}).Where("id = ?", ing.ID).
		Update("nomenclature_id", nom.ID).Error; err != nil {
		return "", "", "", "", err
	}
	if err := recordIngredientSync(tx, []string{ing.ID}); err != nil {
		return "", "", "", "", err
	}
	if err := recordNomenclatureSync(tx, []string{nom.ID}); err != nil {
		return "", "", "", "", err
	}
	return nom.ID, name, unit, price, nil
}

// buildSemiSpec — описание полуфабриката для снапшота: тип + размер + рецепт.
func buildSemiSpec(tx *gorm.DB, rid, accountID, semiTypeID string, now time.Time) (*NetworkSemiSpec, error) {
	var st models.SemiFinishedType
	if err := tx.Where("restaurant_id = ? AND id = ?", rid, semiTypeID).First(&st).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	spec := &NetworkSemiSpec{
		Name:       derefOr(st.Name, ""),
		OutputUnit: derefOr(st.OutputUnit, ""),
		Yield:      decimal.Normalize(st.YieldPercent).String(),
	}
	if st.SizeScaleValueID != nil && *st.SizeScaleValueID != "" {
		var sv models.SizeScaleValue
		if err := tx.Where("id = ?", *st.SizeScaleValueID).First(&sv).Error; err == nil {
			spec.Size = sv.Code
			if sv.Title != nil && *sv.Title != "" {
				spec.Size = *sv.Title
			}
		}
	}
	var recipe []models.SemiRecipeLine
	if err := tx.Where("semi_type_id = ?", semiTypeID).Order("created_at ASC").Find(&recipe).Error; err != nil {
		return nil, err
	}
	for i := range recipe {
		rl := recipe[i]
		if rl.IngredientID == nil || *rl.IngredientID == "" {
			continue
		}
		nomID, name, unit, price, err := ensureIngredientCataloged(tx, rid, accountID, *rl.IngredientID, now)
		if err != nil {
			return nil, err
		}
		if nomID == "" {
			continue
		}
		u := derefOr(rl.Unit, "")
		if u == "" {
			u = unit
		}
		spec.Recipe = append(spec.Recipe, NetworkSemiRecipeLine{
			Nom: nomID, Name: name, QtyPerUnit: decimal.Normalize(rl.QtyPerUnit).String(), Unit: u, Price: price,
		})
	}
	return spec, nil
}

// techCardsSignature — каноническая сигнатура снапшота для сравнения «мастер
// против фактического состояния филиала». Цены НЕ входят (у каждого узла своя
// себестоимость — иначе вечный пересинк), рецепт полуфабриката не входит
// (существующие типы филиала не перезаписываются — авторитет локальный).
func techCardsSignature(tc *NetworkTechCards) string {
	keys := make([]string, 0, len(tc.Cards))
	for k := range tc.Cards {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		b.WriteString("k:" + k + "{")
		lines := make([]string, 0, len(tc.Cards[k]))
		for _, l := range tc.Cards[k] {
			qty := l.Qty
			if d, err := decimal.FromString(l.Qty); err == nil {
				qty = decimal.Normalize(d).String()
			}
			switch {
			case l.Nom != "":
				lines = append(lines, "i:"+l.Nom+"|"+qty+"|"+strings.TrimSpace(l.Unit))
			case l.Semi != nil:
				lines = append(lines, "s:"+strings.ToLower(strings.TrimSpace(l.Semi.Name))+"|"+
					strings.ToLower(strings.TrimSpace(l.Semi.Size))+"|"+qty+"|"+strings.TrimSpace(l.Unit))
			}
		}
		sort.Strings(lines)
		b.WriteString(strings.Join(lines, ";") + "}")
	}
	return b.String()
}
