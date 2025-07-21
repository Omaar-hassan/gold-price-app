import { useState } from "react";
import { json } from "@remix-run/node";
import { useFetcher } from "@remix-run/react";
import { authenticate } from "../shopify.server";

export const meta = () => [
  { title: "تحديث أسعار الذهب" },
  { name: "description", content: "قم بتحديث أسعار منتجات الذهب بسهولة." },
];

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const body = await request.json();

  const { goldPrice, makingCharge, discount, karat, origin } = body;

  try {
    console.log("Fetching products with metafields...");
    const productsResponse = await admin.graphql(`
      {
        products(first: 100) {
          edges {
            node {
              id
              title
              handle
              productType
              tags
              variants(first: 10) {
                edges {
                  node {
                    id
                    price
                    sku
                    inventoryQuantity
                  }
                }
              }
              metafields(first: 15) {
                edges {
                  node {
                    namespace
                    key
                    value
                  }
                }
              }
            }
          }
        }
      }
    `);

    const responseData = await productsResponse.json();
    console.log("Products response received");

    if (!responseData?.data?.products) {
      return json({ 
        error: "فشل في الحصول على المنتجات",
        details: responseData
      }, { status: 400 });
    }

    const products = responseData.data.products.edges;
    const updates = [];
    let productsFound = 0;
    let productsMatched = 0;

    for (const product of products) {
      const metafields = product.node.metafields.edges;
      const variants = product.node.variants.edges;
      productsFound++;

      console.log(`\n--- Product: ${product.node.title} ---`);
      console.log(`Handle: ${product.node.handle}`);
      console.log(`Product Type: ${product.node.productType}`);
      console.log(`Tags: ${product.node.tags}`);

      // Method 1: Check metafields
      const productKarat = metafields.find(m => m.node.key === "karat")?.node.value;
      const productOrigin = metafields.find(m => m.node.key === "origin")?.node.value;
      const metalWeight = parseFloat(metafields.find(m => m.node.key === "metalWeight" || m.node.key === "metal_weight")?.node.value || 0);

      // Method 2: Check if info is in product title or handle
      const titleKarat = extractKaratFromText(product.node.title);
      const titleOrigin = extractOriginFromText(product.node.title);
      
      // Method 3: Check if info is in tags
      const tagKarat = extractKaratFromTags(product.node.tags);
      const tagOrigin = extractOriginFromTags(product.node.tags);

      // Method 4: Check if info is in product type
      const typeKarat = extractKaratFromText(product.node.productType);
      const typeOrigin = extractOriginFromText(product.node.productType);

      // Method 5: Check if weight info is in SKU, title, or other places
      const weightFromSKU = extractWeightFromText(variants[0]?.node.sku || '');
      const weightFromTitle = extractWeightFromText(product.node.title);
      let weightToUse = metalWeight > 0 ? metalWeight : (weightFromSKU || weightFromTitle || 0);

      // Determine karat and origin from multiple sources
      const finalKarat = productKarat || titleKarat || tagKarat || typeKarat;
      const finalOrigin = productOrigin || titleOrigin || tagOrigin || typeOrigin;

      console.log(`Metafields:`, metafields.map(m => ({ key: m.node.key, value: m.node.value })));
      console.log(`Extracted - Karat: ${finalKarat}, Origin: ${finalOrigin}, Weight: ${weightToUse}`);
      
      // Try to get weight from GraphQL variant details if not found
      if (weightToUse === 0 && variants.length > 0) {
        try {
          const variantId = variants[0].node.id.split('/').pop();
          const variantDetailsResponse = await admin.graphql(`
            {
              productVariant(id: "${variants[0].node.id}") {
                weight
                weightUnit
              }
            }
          `);
          
          const variantData = await variantDetailsResponse.json();
          
          if (variantData?.data?.productVariant?.weight && variantData.data.productVariant.weight > 0) {
            const restWeight = variantData.data.productVariant.weight;
            const weightUnit = variantData.data.productVariant.weightUnit;
            
            // Convert weight to grams
            let convertedWeight = restWeight;
            if (weightUnit === 'KILOGRAMS') convertedWeight = restWeight * 1000;
            if (weightUnit === 'POUNDS') convertedWeight = restWeight * 453.592;
            if (weightUnit === 'OUNCES') convertedWeight = restWeight * 28.3495;
            
            console.log(`Found weight from GraphQL: ${convertedWeight}g (original: ${restWeight} ${weightUnit})`);
            weightToUse = convertedWeight;
          }
        } catch (weightError) {
          console.log(`Could not fetch variant weight: ${weightError.message}`);
        }
      }
      
      console.log(`Comparing: ${finalKarat} === ${karat} && ${finalOrigin} === ${origin}`);
      console.log(`Final weight to use: ${weightToUse}`);

      if (finalKarat === karat && finalOrigin === origin && weightToUse > 0) {
        productsMatched++;
        const price = (parseFloat(goldPrice) * weightToUse) + ((weightToUse * parseFloat(makingCharge)) - parseFloat(discount || 0));
        
        console.log(`Calculated price: ${price} for weight: ${weightToUse}`);

        for (const variant of variants) {
          if (price > 0) {
            updates.push({
              productId: product.node.id,
              variantId: variant.node.id,
              price: price.toFixed(2),
              currentPrice: variant.node.price,
              productTitle: product.node.title
            });
          }
        }
      }
    }

    console.log(`\nSummary: Products found: ${productsFound}, matched: ${productsMatched}, updates: ${updates.length}`);
    
    if (updates.length === 0) {
      return json({ 
        message: "لم يتم العثور على منتجات تطابق المعايير المحددة",
        debug: {
          productsFound,
          productsMatched,
          searchCriteria: { karat, origin },
          sampleProducts: products.slice(0, 3).map(p => ({
            title: p.node.title,
            handle: p.node.handle,
            productType: p.node.productType,
            tags: p.node.tags,
            metafields: p.node.metafields.edges.map(m => ({ key: m.node.key, value: m.node.value })),
            variants: p.node.variants.edges.map(v => ({ 
              id: v.node.id, 
              price: v.node.price, 
              sku: v.node.sku,
              inventoryQuantity: v.node.inventoryQuantity
            }))
          }))
        }
      });
    }

    // Update variants using GraphQL mutation with correct mutation name
    let successCount = 0;
    let errorCount = 0;
    const updateErrors = [];

    for (const update of updates) {
      try {
        console.log(`\nUpdating variant ${update.variantId} from ${update.currentPrice} to ${update.price}`);
        
        // Method 1: Try GraphQL mutation first
        let updateSuccessful = false;
        
        try {
          const mutation = `
            mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
              productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                productVariants {
                  id
                  price
                }
                userErrors {
                  field
                  message
                }
              }
            }
          `;

          const variables = {
            productId: update.productId,
            variants: [{
              id: update.variantId,
              price: update.price
            }]
          };

          const mutationResponse = await admin.graphql(mutation, { variables });
          const mutationData = await mutationResponse.json();

          if (mutationData?.data?.productVariantsBulkUpdate?.userErrors?.length > 0) {
            console.log(`GraphQL bulk update failed, trying individual update...`);
            throw new Error(mutationData.data.productVariantsBulkUpdate.userErrors.map(e => e.message).join(', '));
          } else if (mutationData?.data?.productVariantsBulkUpdate?.productVariants?.length > 0) {
            console.log(`✓ Successfully updated variant ${update.variantId} to price ${update.price} using GraphQL bulk`);
            updateSuccessful = true;
            successCount++;
          } else {
            throw new Error("Unexpected GraphQL response");
          }
        } catch (graphqlError) {
          console.log(`GraphQL bulk update failed: ${graphqlError.message}`);
          
          // Method 2: Try single variant GraphQL mutation
          try {
            const singleMutation = `
              mutation ($input: ProductVariantInput!) {
                productVariantUpdate(input: $input) {
                  productVariant {
                    id
                    price
                  }
                  userErrors {
                    field
                    message
                  }
                }
              }
            `;

            const singleVariables = {
              input: {
                id: update.variantId,
                price: update.price
              }
            };

            const singleResponse = await admin.graphql(singleMutation, { variables: singleVariables });
            const singleData = await singleResponse.json();

            if (singleData?.data?.productVariantUpdate?.userErrors?.length > 0) {
              throw new Error(singleData.data.productVariantUpdate.userErrors.map(e => e.message).join(', '));
            } else if (singleData?.data?.productVariantUpdate?.productVariant) {
              console.log(`✓ Successfully updated variant ${update.variantId} to price ${update.price} using GraphQL single`);
              updateSuccessful = true;
              successCount++;
            } else {
              throw new Error("Unexpected single GraphQL response");
            }
          } catch (singleGraphqlError) {
            console.log(`Single GraphQL update failed: ${singleGraphqlError.message}`);
            
            // Method 3: Fallback to REST API using fetch
            try {
              const variantId = update.variantId.split('/').pop();
              const shopDomain = session.shop;
              const accessToken = session.accessToken;
              
              const restResponse = await fetch(`https://${shopDomain}/admin/api/2023-10/variants/${variantId}.json`, {
                method: 'PUT',
                headers: {
                  'X-Shopify-Access-Token': accessToken,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  variant: {
                    id: parseInt(variantId),
                    price: update.price
                  }
                })
              });

              if (restResponse.ok) {
                const restData = await restResponse.json();
                console.log(`✓ Successfully updated variant ${update.variantId} to price ${update.price} using REST API`);
                updateSuccessful = true;
                successCount++;
              } else {
                const errorData = await restResponse.json();
                throw new Error(`REST API error: ${errorData.errors ? JSON.stringify(errorData.errors) : 'Unknown error'}`);
              }
            } catch (restError) {
              console.error(`REST API update failed: ${restError.message}`);
              throw new Error(`جميع طرق التحديث فشلت: GraphQL Bulk (${graphqlError.message}), GraphQL Single (${singleGraphqlError.message}), REST (${restError.message})`);
            }
          }
        }

        if (!updateSuccessful) {
          throw new Error("فشل في جميع طرق التحديث");
        }

      } catch (error) {
        console.error(`✗ Error updating variant ${update.variantId}:`, error.message);
        updateErrors.push({
          productVariant: update.variantId,
          productTitle: update.productTitle,
          message: `خطأ في التحديث: ${error.message}`
        });
        errorCount++;
      }
    }

    if (errorCount > 0 && successCount === 0) {
      return json({ 
        error: `فشل في تحديث جميع المنتجات (${errorCount} منتج)`,
        details: updateErrors
      }, { status: 400 });
    } else if (errorCount > 0) {
      return json({ 
        message: `تم تحديث ${successCount} منتج، فشل ${errorCount} منتج`,
        details: updateErrors,
        updatedCount: successCount
      }, { status: 200 });
    }

    return json({ 
      message: `تم تحديث ${successCount} منتج بنجاح.`,
      updatedCount: successCount,
      debug: {
        productsFound,
        productsMatched,
        formData: { goldPrice, makingCharge, discount, karat, origin }
      }
    });

  } catch (error) {
    console.error("Error updating prices:", error);
    return json({ 
      error: "حدث خطأ أثناء تحديث الأسعار",
      details: error.message 
    }, { status: 500 });
  }
};

// Helper functions to extract information from different sources
function extractWeightFromText(text) {
  if (!text) return null;
  // البحث عن أرقام متبوعة بكلمات مثل "جرام", "gram", "g"
  const weightMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:جرام|جم|gram|grams|g\b)/i);
  if (weightMatch) {
    return parseFloat(weightMatch[1]);
  }
  
  // البحث عن أرقام في نهاية SKU (مثل: GLD-21K-5.5)
  const numberMatch = text.match(/(\d+(?:\.\d+)?)(?:$|[^\d])/);
  if (numberMatch && parseFloat(numberMatch[1]) > 0 && parseFloat(numberMatch[1]) < 100) {
    return parseFloat(numberMatch[1]);
  }
  
  return null;
}

function extractKaratFromText(text) {
  if (!text) return null;
  const karatMatch = text.match(/(\d+k|\d+\s*قيراط|\d+\s*carat)/i);
  if (karatMatch) {
    const number = karatMatch[1].match(/\d+/)[0];
    return `${number}k`;
  }
  return null;
}

function extractOriginFromText(text) {
  if (!text) return null;
  text = text.toLowerCase();
  if (text.includes('محلي') || text.includes('local')) return 'محلي';
  if (text.includes('مستورد') || text.includes('imported') || text.includes('import')) return 'مستورد';
  return null;
}

function extractKaratFromTags(tags) {
  if (!Array.isArray(tags)) return null;
  for (const tag of tags) {
    const karat = extractKaratFromText(tag);
    if (karat) return karat;
  }
  return null;
}

function extractOriginFromTags(tags) {
  if (!Array.isArray(tags)) return null;
  for (const tag of tags) {
    const origin = extractOriginFromText(tag);
    if (origin) return origin;
  }
  return null;
}

export default function GoldPriceEditor() {
  const fetcher = useFetcher();
  const [form, setForm] = useState({
    goldPrice: "",
    makingCharge: "",
    discount: "",
    karat: "21k",
    origin: "محلي",
  });

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!form.goldPrice || !form.makingCharge) {
      alert("يرجى ملء جميع الحقول المطلوبة");
      return;
    }

    fetcher.submit(JSON.stringify(form), {
      method: "post",
      encType: "application/json",
    });
  };

  const isLoading = fetcher.state === "submitting" || fetcher.state === "loading";

  return (
    <div style={{ maxWidth: 600, margin: "2rem auto", fontFamily: "Arial", direction: "rtl" }}>
      <h1>تحديث أسعار الذهب</h1>
      
      <div style={{ marginBottom: "2rem", padding: "1rem", backgroundColor: "#e7f3ff", borderRadius: "8px", fontSize: "0.9em" }}>
        <h3>طرق تحديد المنتجات:</h3>
        <p><strong>1. Metafields:</strong> karat, origin, metalWeight (أو metal_weight)</p>
        <p><strong>2. عنوان المنتج:</strong> مثل "خاتم ذهب 21k محلي 5 جرام"</p>
        <p><strong>3. Tags:</strong> مثل ["21k", "محلي", "5g"]</p>
        <p><strong>4. Product Type:</strong> مثل "21k Gold Ring Local"</p>
        <p><strong>5. SKU:</strong> مثل "GLD-21K-LOC-5.5" (الرقم الأخير = الوزن)</p>
        <p><strong>6. وزن المتغير:</strong> من إعدادات Shopify (بالجرام)</p>
        
        <div style={{ marginTop: "1rem", padding: "0.5rem", backgroundColor: "#fff3cd", borderRadius: "4px" }}>
          <strong>ملاحظة:</strong> يجب أن يحتوي كل منتج على الوزن بإحدى الطرق أعلاه ليتم تحديث سعره.
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: "1rem" }}>
          <label style={{ display: "block", marginBottom: "0.5rem" }}>
            سعر الذهب للجرام (بالجنيه): *
          </label>
          <input
            type="number"
            step="0.01"
            min="0"
            name="goldPrice"
            value={form.goldPrice}
            onChange={handleChange}
            required
            style={{ width: "100%", padding: "0.5rem" }}
            disabled={isLoading}
          />
        </div>

        <div style={{ marginBottom: "1rem" }}>
          <label style={{ display: "block", marginBottom: "0.5rem" }}>
            سعر المصنعية لكل جرام: *
          </label>
          <input
            type="number"
            step="0.01"
            min="0"
            name="makingCharge"
            value={form.makingCharge}
            onChange={handleChange}
            required
            style={{ width: "100%", padding: "0.5rem" }}
            disabled={isLoading}
          />
        </div>

        <div style={{ marginBottom: "1rem" }}>
          <label style={{ display: "block", marginBottom: "0.5rem" }}>
            الخصم:
          </label>
          <input
            type="number"
            step="0.01"
            min="0"
            name="discount"
            value={form.discount}
            onChange={handleChange}
            style={{ width: "100%", padding: "0.5rem" }}
            disabled={isLoading}
          />
        </div>

        <div style={{ marginBottom: "1rem" }}>
          <label style={{ display: "block", marginBottom: "0.5rem" }}>
            القيراط:
          </label>
          <select 
            name="karat" 
            value={form.karat} 
            onChange={handleChange}
            style={{ width: "100%", padding: "0.5rem" }}
            disabled={isLoading}
          >
            <option value="14k">14k</option>
            <option value="18k">18k</option>
            <option value="21k">21k</option>
            <option value="24k">24k</option>
          </select>
        </div>

        <div style={{ marginBottom: "1rem" }}>
          <label style={{ display: "block", marginBottom: "0.5rem" }}>
            المنشأ:
          </label>
          <select 
            name="origin" 
            value={form.origin} 
            onChange={handleChange}
            style={{ width: "100%", padding: "0.5rem" }}
            disabled={isLoading}
          >
            <option value="محلي">محلي</option>
            <option value="مستورد">مستورد</option>
          </select>
        </div>

        <button 
          type="submit" 
          style={{ 
            marginTop: "1rem", 
            padding: "0.75rem 1.5rem",
            backgroundColor: isLoading ? "#ccc" : "#007cba",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: isLoading ? "not-allowed" : "pointer",
            width: "100%"
          }}
          disabled={isLoading}
        >
          {isLoading ? "جاري التحديث..." : "تحديث الأسعار"}
        </button>
      </form>

      {fetcher.data?.message && (
        <div style={{ marginTop: "1rem", padding: "1rem", backgroundColor: "#d4edda", color: "#155724", borderRadius: "4px", textAlign: "center" }}>
          <p>{fetcher.data.message}</p>
          {fetcher.data.updatedCount && (
            <p style={{ fontSize: "0.9em", marginTop: "0.5rem" }}>
              عدد المنتجات المحدثة: {fetcher.data.updatedCount}
            </p>
          )}
        </div>
      )}

      {fetcher.data?.error && (
        <div style={{ marginTop: "1rem", padding: "1rem", backgroundColor: "#f8d7da", color: "#721c24", borderRadius: "4px", textAlign: "center" }}>
          <p>{fetcher.data.error}</p>
          {fetcher.data?.details && (
            <details style={{ marginTop: "0.5rem", textAlign: "left", fontSize: "0.9em" }}>
              <summary>تفاصيل الخطأ</summary>
              <pre style={{ background: "#f5f5f5", padding: "0.5rem", borderRadius: "4px", overflow: "auto", maxHeight: "300px" }}>
                {JSON.stringify(fetcher.data.details, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}

      {fetcher.data?.debug && (
        <details style={{ marginTop: "1rem", fontSize: "0.9em" }}>
          <summary>معلومات التشخيص</summary>
          <pre style={{ background: "#f8f9fa", padding: "1rem", borderRadius: "4px", overflow: "auto", maxHeight: "400px" }}>
            {JSON.stringify(fetcher.data.debug, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}