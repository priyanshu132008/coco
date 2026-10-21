import * as fs from 'node:fs'
import * as path from 'node:path'

// ponytail: image_base64 entries are 1px placeholder pixels — swap in real emulator
// captures (adb screencap → base64) when visual fidelity is needed; the XML
// hierarchies are the load-bearing part for layout fine-tuning.

/** Minimal valid 1×1 PNG, base64. */
const PLACEHOLDER_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

interface MobileScreenEntry {
  intent: string
  xml: string
  action: 'CLICK' | 'TYPE'
  selector: string
  payload?: string
}

const SCREENS: MobileScreenEntry[] = [
  {
    intent: 'Enter UPI PIN to authorize payment',
    selector: 'com.phonepe.app:id/upi_pin_entry',
    action: 'TYPE',
    payload: '1234',
    xml: `<node index="0" class="android.widget.FrameLayout" package="com.phonepe.app" bounds="[0,0][1280,800]">
  <node index="1" class="android.widget.TextView" text="Paying Swiggy ₹349"/>
  <node index="2" class="android.widget.TextView" text="HDFC Bank •••• 4821"/>
  <node index="3" class="android.widget.EditText" resource-id="com.phonepe.app:id/upi_pin_entry" content-desc="Enter 4 digit UPI PIN" data-oi="mob-upi-pin" clickable="true" focused="true"/>
  <node index="3" class="android.widget.TextView" text="Forgot UPI PIN?"/>
  <node index="4" class="android.widget.Button" resource-id="com.phonepe.app:id/btn_submit_pin" text="PAY ₹349" clickable="true"/>
  <node index="5" class="android.widget.ImageButton" content-desc="Cancel payment" clickable="true"/>
</node>`,
  },
  {
    intent: 'Confirm money transfer to contact',
    selector: 'com.google.android.apps.nbu.paysid:id/send_money_button',
    action: 'CLICK',
    xml: `<node index="0" class="android.widget.ScrollView" package="com.google.android.apps.nbu.paysid" bounds="[0,0][1280,800]">
  <node index="1" class="android.widget.TextView" text="Paying Priya Sharma" content-desc="Contact name"/>
  <node index="1" class="android.widget.TextView" text="priya.sharma@okhdfcbank"/>
  <node index="2" class="android.widget.TextView" text="₹2,500" content-desc="Amount"/>
  <node index="2" class="android.widget.EditText" resource-id="com.google.android.apps.nbu.paysid:id/note_field" hint="Add a note"/>
  <node index="3" class="android.widget.RadioButton" text="HDFC Bank •••• 4821" checked="true"/>
  <node index="4" class="android.widget.Button" resource-id="com.google.android.apps.nbu.paysid:id/send_money_button" text="Pay ₹2,500" data-oi="mob-transfer-confirm" clickable="true"/>
</node>`,
  },
  {
    intent: 'Type message and send in chat',
    selector: 'com.whatsapp:id/send',
    action: 'TYPE',
    payload: 'On my way 🚗',
    xml: `<node index="0" class="android.widget.RecyclerView" package="com.whatsapp" bounds="[0,0][1280,800]">
  <node index="1" class="android.widget.TextView" text="Ananya" content-desc="Chat header"/>
  <node index="2" class="android.widget.TextView" text="Did you send the file?" content-desc="Received message"/>
  <node index="3" class="android.widget.TextView" text="Yes, done ✅" content-desc="Sent message"/>
  <node index="4" class="android.widget.ImageButton" content-desc="Attach" clickable="true"/>
  <node index="5" class="android.widget.EditText" resource-id="com.whatsapp:id/entry" hint="Message" data-oi="mob-chat-input" clickable="true"/>
  <node index="6" class="android.widget.ImageButton" resource-id="com.whatsapp:id/send" content-desc="Send" clickable="true"/>
</node>`,
  },
  {
    intent: 'Open search and switch to Reels tab',
    selector: 'com.instagram.android:id/tab_icon_reels',
    action: 'CLICK',
    xml: `<node index="0" class="android.widget.FrameLayout" package="com.instagram.android" bounds="[0,0][1280,800]">
  <node index="1" class="android.widget.AutoCompleteTextView" resource-id="com.instagram.android:id/action_bar_search_edit_text" hint="Search" data-oi="mob-insta-search" clickable="true"/>
  <node index="2" class="android.widget.RecyclerView">
    <node class="android.widget.TextView" text="zomato"/>
    <node class="android.widget.TextView" text="swiggyindia"/>
    <node class="android.widget.TextView" text="indianrailways"/>
  </node>
  <node index="3" class="android.widget.LinearLayout" content-desc="Bottom navigation">
    <node class="android.widget.ImageView" content-desc="Home" clickable="true"/>
    <node class="android.widget.ImageView" content-desc="Search and explore" clickable="true"/>
    <node class="android.widget.ImageView" resource-id="com.instagram.android:id/tab_icon_reels" content-desc="Reels" data-oi="mob-reels-tab" clickable="true"/>
    <node class="android.widget.ImageView" content-desc="Shop" clickable="true"/>
    <node class="android.widget.ImageView" content-desc="Profile" clickable="true"/>
  </node>
</node>`,
  },
  {
    intent: 'Review cart items and proceed to payment',
    selector: 'com.application.zomato:id/btn_proceed_to_pay',
    action: 'CLICK',
    xml: `<node index="0" class="android.widget.ScrollView" package="com.application.zomato" bounds="[0,0][1280,800]">
  <node index="1" class="android.widget.TextView" text="Your cart · 2 items"/>
  <node index="2" class="android.widget.LinearLayout" text="Paneer Butter Masala ₹349">
    <node class="android.widget.Button" content-desc="Decrease quantity" clickable="true"/>
    <node class="android.widget.TextView" text="1"/>
    <node class="android.widget.Button" resource-id="com.application.zomato:id/btn_add" text="ADD" clickable="true"/>
  </node>
  <node index="3" class="android.widget.TextView" text="Item Total ₹648 | GST ₹54 | Delivery ₹45"/>
  <node index="3" class="android.widget.TextView" text="To Pay ₹747" content-desc="Bill total"/>
  <node index="4" class="android.widget.TextView" text="UPI · GPay · PhonePe · Paytm accepted"/>
  <node index="5" class="android.widget.Button" resource-id="com.application.zomato:id/btn_proceed_to_pay" text="Proceed to Pay ₹747" data-oi="mob-cart-pay" clickable="true"/>
</node>`,
  },
  {
    intent: 'Select UPI payment method on checkout summary',
    selector: 'com.application.zomato:id/pay_option_upi',
    action: 'CLICK',
    xml: `<node index="0" class="android.widget.ScrollView" package="com.application.zomato" bounds="[0,0][1280,800]">
  <node index="1" class="android.widget.TextView" text="Choose payment method"/>
  <node index="2" class="android.widget.TextView" text="To Pay ₹747"/>
  <node index="3" class="android.widget.LinearLayout" resource-id="com.application.zomato:id/pay_option_upi" data-oi="mob-pay-upi" clickable="true">
    <node class="android.widget.TextView" text="UPI · Google Pay, PhonePe, Paytm"/>
  </node>
  <node index="4" class="android.widget.LinearLayout" resource-id="com.application.zomato:id/pay_option_card" clickable="true">
    <node class="android.widget.TextView" text="Credit / Debit Card"/>
  </node>
  <node index="5" class="android.widget.TextView" text="Powered by Razorpay"/>
  <node index="6" class="android.widget.Button" resource-id="com.application.zomato:id/btn_pay_now" text="Pay Now ₹747" clickable="true"/>
</node>`,
  },
  {
    intent: 'Enter OTP on verification screen',
    selector: 'com.otpview:id/otp_box_1',
    action: 'TYPE',
    payload: '482910',
    xml: `<node index="0" class="android.widget.FrameLayout" package="com.otpview" bounds="[0,0][1280,800]">
  <node index="1" class="android.widget.TextView" text="Verify your number +91 98••• ••210"/>
  <node index="2" class="android.widget.EditText" resource-id="com.otpview:id/otp_box_1" content-desc="OTP digit 1" data-oi="mob-otp-1" clickable="true" focused="true"/>
  <node index="2" class="android.widget.EditText" resource-id="com.otpview:id/otp_box_2" clickable="true"/>
  <node index="2" class="android.widget.EditText" resource-id="com.otpview:id/otp_box_3" clickable="true"/>
  <node index="2" class="android.widget.EditText" resource-id="com.otpview:id/otp_box_4" clickable="true"/>
  <node index="2" class="android.widget.EditText" resource-id="com.otpview:id/otp_box_5" clickable="true"/>
  <node index="2" class="android.widget.EditText" resource-id="com.otpview:id/otp_box_6" clickable="true"/>
  <node index="3" class="android.widget.TextView" text="Resend OTP in 0:24"/>
  <node index="4" class="android.widget.Button" resource-id="com.otpview:id/btn_verify" text="VERIFY & CONTINUE" clickable="true"/>
</node>`,
  },
]

export class MobileDatasetExpander {
  private outPath = path.resolve(__dirname, '..', '..', '..', '..', 'indian_ui_train.jsonl')

  run(): { added: number; total: number } {
    const existing = new Set<string>()
    let total = 0
    if (fs.existsSync(this.outPath)) {
      for (const line of fs.readFileSync(this.outPath, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line)
          existing.add(`${r.intent}::${r.dom_snippet}`)
          total++
        } catch {
          // keep the dataset clean of neighbors that aren't valid JSON
        }
      }
    }
    let added = 0
    for (const s of SCREENS) {
      if (existing.has(`${s.intent}::${s.xml}`)) continue
      const record = {
        image_base64: PLACEHOLDER_PNG,
        dom_snippet: s.xml,
        intent: s.intent,
        action_choice: JSON.stringify({ action: s.action, selector: s.selector, ...(s.payload ? { payload: s.payload } : {}) }),
      }
      fs.appendFileSync(this.outPath, JSON.stringify(record) + '\n')
      added++
      total++
    }
    console.log(`[dataset-ex] +${added} synthetic mobile records → ${this.outPath} (total ${total})`)
    return { added, total }
  }
}

if (require.main === module) new MobileDatasetExpander().run()