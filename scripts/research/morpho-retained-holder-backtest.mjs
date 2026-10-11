// Offline fold of a frozen retained archive. Importing never opens a provider or writes.
// CLI: node --import tsx scripts/research/morpho-retained-holder-backtest.mjs verify <analysisAt>
// The installed tsx loader is needed by a transitive TypeScript route-identity import.
import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, fsyncSync, openSync, readFileSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BOARD_ROUTES } from './carry-local-morpho-holder-v2.mjs'
import { validateRecord } from './carry-morpho-retrospective-holder-pairs.mjs'
import { validateCarryExitV2RpcProof } from '../lib/carry-exit-v2-rpc-proof.mjs'
import { assembleCarryExitV2CallEvidence } from '../lib/carry-exit-v2-proof-assembly.mjs'

export const SCHEMA = 'morpho-retained-full-holder-backtest-v1'
export const OUTPUT = 'data/research/venue-signals/morpho-retained-holder-backtest-2026-10-08.json'
// Frozen before analysis; neither a command-line tag nor a new seal can expand this cohort.
export const INPUT_PINS = Object.freeze([
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-grid-v1.json",
    "fileSha256": "62d4d2e7fa320ed3b86763677169635f1381c71e20369bcf3f95c527af521829",
    "contentSha256": "2a7aec6466c78b4b04ac1c9172f2e1aac12419e991e642cea6c807cf28cba3b6"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/00-000025240302.json",
    "fileSha256": "526c6ada0675744d80b1210bfc449a51e80bd6922fc73a4c8cb79982360ed050",
    "contentSha256": "ed8440e2df21361c1ac2e10172d8618cfe81ab66f62ec0a665c9443ca7a962be"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/01-000025240302.json",
    "fileSha256": "370524d8a2f198e6fdfa3ad024453ef593c2fa7016c3cbcbf5416789cae4b044",
    "contentSha256": "cfa3bc2699b696e7d5d2c536174335ad456ff05255a9205b3a2c5b46f5d5fe52"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/01-000025880884.json",
    "fileSha256": "559800154bfafd65cae6089be9a68a2d3a78c4e4539d3091014420537c801c86",
    "contentSha256": "77ff5146d77c4c9eb5b1ed65b5f78e57170aaac54ae29ffa4708e51f15b43cd1"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/02-000025240302.json",
    "fileSha256": "10b0a2e91a57b87e81814e39ef18d5efb52d07acac4d0eb74040f2a0075fcc26",
    "contentSha256": "b5eab2ea49ca831bc76771125105224bda2ec52ed9669a3ee8c2a026d8a95477"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/02-000025880887.json",
    "fileSha256": "26537d2949c00adbec06de3733226167ed02ece68da7daa292a59a753dcd36f0",
    "contentSha256": "de58e234d11f20350be51a7bf7dde4201c5a877f60116ff3d339fdf73f87ca2d"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/03-000025240302.json",
    "fileSha256": "a2232e1a8b7da5549225b042eb0666894e3c5dc99d539a442258277cbe86caf6",
    "contentSha256": "fb010cca5fc2f20e55667e90d0630321ae73c2b2a02ce2d85dd5f12175bb65ed"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/04-000025240302.json",
    "fileSha256": "975337e8ba0bd73aa144d0641b11ad870f79b5416efc14bd74954d558fa39e48",
    "contentSha256": "34862fdddb79739fb7dd4bfda3745865c9159a4a9789df362497773a0cc82d7f"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/05-000025240302.json",
    "fileSha256": "92ba53f882c9d59169b7ba5165ff7d2140d9d8c34393a4a3164467b596b0758c",
    "contentSha256": "12436c7900110f7b34c9d859a086082b16247b7633576b419b85437b4d4ba2bd"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/05-000025881014.json",
    "fileSha256": "a9f33c1cec4c550e36db4c1472b59a9f92ad6f6fc8916efc12d65d515f577a39",
    "contentSha256": "572c50885699bb484fc3c3ed53251973e40ab89474b076b8356b4a1a026c0c55"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/06-000025240302.json",
    "fileSha256": "c3396af47791b3bbb133bd8a2790b1f44f10b8751316ea4cb1ed3b914982603e",
    "contentSha256": "be7d52e8abd660156163369b91b1ae655cfd99f24ae6be474d652609cba7d1fb"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/06-000025880375.json",
    "fileSha256": "c55f1816f1120dee5600c603f4c402693d8b24326a00f0fe1da06f20293a0fed",
    "contentSha256": "3eb77a443d6612307066e0ffca5d697053135d49d783b847f0ac1f38e0228c38"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/07-000025240302.json",
    "fileSha256": "a7e458aa062a4baa2c1d1c4b1fe96452b81e4cef099b0ca025d11daac856cf32",
    "contentSha256": "fc51e496642c947bc2e3fe1316cfd81586904edfaa21e77361e28e4c14be24d5"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/08-000025240302.json",
    "fileSha256": "2ed2a25092d87f44d7db678dc09e61083afeb8e1743d7735646c57f53760c4f4",
    "contentSha256": "d5b2303285539a28c070ba25cb135a277400aa2abe047c48047413e028836b3d"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/09-000025240302.json",
    "fileSha256": "4cb87790068882a86a60154f70a287f4f9edb93e9e4659d3035df70da01c52bc",
    "contentSha256": "9ecfbf7c9666b9bcefb730208c7e6f3a05725a3f5dc81fe7a2a974fde1596225"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/09-000025880585.json",
    "fileSha256": "55386e9b29eaf2a681eb63ec4e1db9f88729489482527fdc2220114d98fee484",
    "contentSha256": "a84d954199007da83c2c0aaf2e3ad0dd94f547c3a6cfc56be1f4bda6601941fb"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/10-000025240302.json",
    "fileSha256": "ea64f9287832fc86a4731ab2e391d75d0f961df3de253bbfc125c5dc1095ebfd",
    "contentSha256": "b48be57c703d65a2cfe42e511803ead94a5f7518ddabbf133785d4b72e55c55a"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/10-000025312002.json",
    "fileSha256": "05c2c85af640e26385e8f964daf32905f0b67097ead479bbcf87ecde00d9aa33",
    "contentSha256": "e470cb7ddbacef7819001ff8be1a2dc435649c7377e853230f668747140ecb16"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/10-000025383756.json",
    "fileSha256": "4adbf5702160f3b6bfd700c9ed54ae8c74d9e552e17d4020ddc4725db85eb26b",
    "contentSha256": "15cb44ff894a77590cfdc47d961e8216dd380b40fb508585e4d2ed8adb136796"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/10-000025399894.json",
    "fileSha256": "6ba54991eb5b143bc809de638dc0a3590c2c1b3bfe913c4755abe1b40afe98a3",
    "contentSha256": "3c517bc6d4667539875b0a2b478086dc980321a6665ede38ef86910c7c01bb4d"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/10-000025455433.json",
    "fileSha256": "ad2ec9e4ef368b5cad61a832d0aded99bc0e31e48d3febb06c934e3198fe9e37",
    "contentSha256": "26df015eda7d3b943d247fe5bff2ca46393c045054c1d0efb1231ac20f6fedc5"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/10-000025527154.json",
    "fileSha256": "7cc9c1b4070e4f05a92e5bef152a25aee5c45da37888e77ab50e44cbd095a092",
    "contentSha256": "cfd076668ad8332aa8b84ff7f290937721f305c66504349d6f9636e88f4a61db"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/10-000025598869.json",
    "fileSha256": "d9b11e2c1f8804672b8fc5ab4fd1d7c2908d3614311f5d892a9c7d585c241eef",
    "contentSha256": "02ff6cbe0c7ffafc62c624d160da74b1c221f698e810069c324a7a55993b88e9"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/10-000025670641.json",
    "fileSha256": "9e9d93fdd073106cdf920fc954c37d1045f7815c152480b7abd6f10cbddb7d60",
    "contentSha256": "528f38d0dbb0ae5aa1ef022e45a402c93d82295632c3bc641a6ac70ffb92bf37"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/10-000025742366.json",
    "fileSha256": "9748fa893cb36a8c52c022fc18f6ee3df63c24f708b714e5aa1f7ed029f3e16f",
    "contentSha256": "630eb4076c681650eb11ce6a3d5638057e3b1fc51e36080b2fae9e3db36c200f"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/10-000025814126.json",
    "fileSha256": "65901bb8bb6f10188f7e80124ac912e5dbcb9516ae387f6c1a676f7f355108e5",
    "contentSha256": "d88d62b72a51d4e48e605310f35f7ea4ff432dda0a4bf14cb5724f900b763a7e"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/10-000025885878.json",
    "fileSha256": "07ad871f8685e76a7fee25ec3110ebe30381254174af7953c48eb75081373f72",
    "contentSha256": "d7dfa5de8a1c67fa44484a6bcb8fef0f96dde49666f6663419938b9b54003d08"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/10-000025888220.json",
    "fileSha256": "c4495a7f5425c30193126a6d57ba49694d18fc73cb5597322bfb663acdf4d5b1",
    "contentSha256": "a45c14261ac349130a62cc5d67c1e5cdad37ab2c2ef34d5c825798a990efa40e"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/10-000025957605.json",
    "fileSha256": "71808066c8cfd46d0c74ce5e8b172af21d7f3910f146811dbb47d5daeb4d2ded",
    "contentSha256": "c36bf791cd1106b7dd102d5ec925081549d68d28bf1631040e7c598de79797be"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/10-000025997681.json",
    "fileSha256": "11c6f1c611ab20fe11b37f5bcfee60febe3b2b90bcf9ba8f908b74d51ec07958",
    "contentSha256": "f3e70632eb259e12e4df0816bcee752f1d79b51082e9086f6cb2c7c377d97703"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/10-000026029315.json",
    "fileSha256": "c9d01b168dad9e38542fbb96aac9ba40f3a47f84caf031fe8aaee0e9e426d215",
    "contentSha256": "cc4fa84b9672fe9f0b3e4c749b73054e3fdf41f5d4a97d993960712604880e4f"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/11-000025240302.json",
    "fileSha256": "11c24f1d542a3ba9d1ba9d8e9cdfbabca4785c471967d932bfb676d6c6def193",
    "contentSha256": "5fc8286a9c0fa49c96889fb8f730e3bda73112089deca78059b38f2822815c2f"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/11-000025880375.json",
    "fileSha256": "76c55fcf45dba747e4a35dd8de8f373d97b2f58870b9e3aa95255be2371b21c5",
    "contentSha256": "a20af4fad6516be28d238f775eccd61d86b95dc94a316b9611dae8c2fdc12c3b"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/12-000025240302.json",
    "fileSha256": "6408d4d218d648db57b73b6dbd4075cd327b7c536072e46b6e5d4359a9edc78e",
    "contentSha256": "b33921e7e60977290a6e88c64ead56fd934060d8b276a850d2662fdfd53fee83"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/13-000025240302.json",
    "fileSha256": "a841351ccb60a6ca58c4e554cf51bcb3b793ed8bd8b55ac415f8e0a9c01e301e",
    "contentSha256": "30d9db05ccf784641dc80d7c1839696b454dc99449f3028e43408120b3f140d3"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/14-000025240302.json",
    "fileSha256": "fca2ef957411c1dc375bde8fe3e9b8deb2669ea1fb5e1c81b5fcafe6e320a63d",
    "contentSha256": "f73b983c6512656dcf0522bb8969a11fd7ab8ed5c97665fada7d86b46a9a7c02"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/15-000025240302.json",
    "fileSha256": "60d0b3393b1543a13368e43da1952b9d05aab8eac9a8df2d50c162e46541a67a",
    "contentSha256": "b87c4ec5d5dc94cd4308101356a23ca2814230b87bd790fcb178675fa9441b69"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/16-000025240302.json",
    "fileSha256": "7aa28ec721cc9843bfc37beb5c57f69ce234dbd7198f81d194f4e353ee0c2347",
    "contentSha256": "2bb7ade4f0dbef3a43a5772b892406f3a48aeb16b3687f25698a4a98dff48e3c"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/17-000025240302.json",
    "fileSha256": "f74a868670c864f0207e7e1d7492305b9eb1db68d99db11f4c1c4047be526532",
    "contentSha256": "f11007bcb6264876b9e05c0991e9a2cd42f1b5b5677a2716c96f67998f955d76"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/18-000025240302.json",
    "fileSha256": "54fc625392863cffa37c747292c66af49739e13407d58dbcf011826812e19eeb",
    "contentSha256": "5cf5fcf284bf24e5e008e9da78937316902493e47a2bf76499dad3e607b131f4"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/19-000025240302.json",
    "fileSha256": "9a8c62c69e3846108be64229ea0afe71d3b81671a0591dff1a80ded3ba312409",
    "contentSha256": "8089b5e8eebf29a7501a8a505e242b765bc4846ef20f3b48d2a0f8d854ae3e8a"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/20-000025240302.json",
    "fileSha256": "9c4e731cfaae40c910a13c5caa86aeaf4dc8561ba1624707bdfccca0f0dda5e9",
    "contentSha256": "17d5f6e6f3fab1973c05b9e7b4104ae18fb5e95654f3f5b5b0d2190abf824167"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/21-000025240302.json",
    "fileSha256": "3a9b075aef6f486e870f3714b7160280b08c0bc051d6b01e9c3013d919f10e24",
    "contentSha256": "8558ee9d20200be4f1db6c98904b9ee1a2a0e1fdc4fcc6f302d611281265129d"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/22-000025240302.json",
    "fileSha256": "774344fded7cb0fe3298e433966630c50e0c556f1fdef2f5f63e1af711d39edf",
    "contentSha256": "6d73c4fe321f60126986941ca5860f78a06bfbec0d1a6173aa35055573828b8f"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/23-000025240302.json",
    "fileSha256": "2ac97514b0a7053b25704edb104a5ee922d99a84866ef5b20d1709f59b94e289",
    "contentSha256": "3d1f31720ef01d36014c9655a37931e10d3f7c2bdb4c37af72e6d365d95e8f54"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/24-000025240302.json",
    "fileSha256": "0141fd9dc0ad257a59db265d5656735f7dfa1029f57096163b4681b197780e20",
    "contentSha256": "a0f5fb87698141c5f9ca640616205852041a880557c9275c1a090bbe5041d396"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/25-000025240302.json",
    "fileSha256": "593a1fc13f5a79143b6df36634a76788aca6654eba54c8a41054551d3722f238",
    "contentSha256": "08070f637938b6b6edead7116b89a2ff822baaea4a5ff985fb588a895ada019c"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/26-000025240302.json",
    "fileSha256": "3c52303389a1fec2326197b0bcf56e9b0187231ce3c3647e4ad66a8a564505ca",
    "contentSha256": "9b4c262ffbce66163d48ff2aa865daa377a8a5406c7481cb7fc9f6e55ee920be"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/27-000025240302.json",
    "fileSha256": "3a9bffffbb6e11a977b9838e6682ffc3bcf07f14fb511b84b111044f76c05e9f",
    "contentSha256": "8af157240e1a328dd5924161ee353a08026c123149803401f810a4e2d22d5365"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/28-000025240302.json",
    "fileSha256": "7ba8dd9de5b5b6192a700334d190758f9d5b2abc5ef0132d37dae8579e89a94a",
    "contentSha256": "a34484b640089fab2e8d515a7e28b355534638101a3da2935b6b6b63d35e8cfd"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/29-000025240302.json",
    "fileSha256": "4ffa1bdb03ecf50847353dfad34b4365ee60159942507dec31792156d2244518",
    "contentSha256": "5d973a9552787d76a9658e6d612283dd56ee4217df3ed05c8417354eb98afbef"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/30-000025240302.json",
    "fileSha256": "b8eda154757fd339986b74252735b1f3f4d5785edc920ccecc2f9b0eabf7f447",
    "contentSha256": "9f86b7a397039ed19fb1fbb4ea643767ed35a53578f6ab70c5335fcd38193834"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/31-000025240302.json",
    "fileSha256": "8880f102d5b9a9861ace47438b430007e040a9a4ac163a27c22f83186087aa3d",
    "contentSha256": "e288f6898678d97e6a483db152eb1498aedf38312987ba4546ee62499c10fab8"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/32-000025240302.json",
    "fileSha256": "6751017f2909ec562f8b6af6521e2eb6da55f0dd19ced2f980aae227c92025cf",
    "contentSha256": "8502fb8dc31a91833d1a3a08d51b235e144db7f9bfb2f439eb6199f46ae42821"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/33-000025240302.json",
    "fileSha256": "d2291884abc29ac1c974005c49ae255072250a5f5dfc8c4ce1911bfdf1672bb7",
    "contentSha256": "12dddaa35bcef5582a94f9f7fc8d9295e95cf7a317259306467f0e3d52d310a3"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/34-000025240302.json",
    "fileSha256": "e1debaf29de341fad97a01b9af2461c28bf4c60d1439a6c361cd571bf90fa9d7",
    "contentSha256": "0e882579a219c26f141131ecb7731395b43ef629fd90cfbe2c2cb540a2b7c4a3"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/35-000025240302.json",
    "fileSha256": "85daa34b0df2d93561ca6bd2db9bf3a1e4fe09268583df404783dfbe5b89b0ae",
    "contentSha256": "ed43e5202bef0fca7eac16db1ac096ab9b4c05133895f3c443d76a3d58f621cb"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/36-000025240302.json",
    "fileSha256": "1006a87a38fa4b19407b266e43702d98c7fd4d64b78bb9aeb7d2da386080286a",
    "contentSha256": "5aef4e9066080609835e7c2ac31c02b9c4f9201cc353c3ce1d9073d287bb8f88"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/37-000025240302.json",
    "fileSha256": "02b80bebcf4801707fa3cb35250721a6032a0a1c90170ed28383c9fece1a0602",
    "contentSha256": "267f223ff08e41590dc566d034d9b4098096b99386ee4799c3d25d44729fb69f"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/38-000025240302.json",
    "fileSha256": "1b1625e5b73ebdd484c0ead64875432742cff0faa718a63fc1d99ba4d5f76c2d",
    "contentSha256": "1a65726c5d82d18856b661f2a825bee75de4c485cf76355198cead9958ea4276"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/38-000025312002.json",
    "fileSha256": "ff526bd62f2b6887995c4a704336d4d5ea9ce5acdefb8b7b47b61617cb67fce3",
    "contentSha256": "5606c1e8f0609dad5c7bab6050832d4a87c9887be8f33b3bb3c4dcc1e23f99a6"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/38-000025383756.json",
    "fileSha256": "3e9edcb6bf4a3df01877dbc11758b1d4095e6fa9f01da6b7c2c7eac8f3e73592",
    "contentSha256": "2cc9b7f5867d7c41f862b7a21cba7512fe42e0af321dc876bc88e8379132cf4b"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/38-000025455433.json",
    "fileSha256": "c4e8010c845da8aea2642c247e6d2a1200b5c42af8d612a3231a6c7b63edb7c8",
    "contentSha256": "7726f3a48292769d165053dd3c0273365330def330ed775217557b9740934213"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/38-000025527154.json",
    "fileSha256": "443c1d0a5c74d7348f78fac9e5aa04e567a898e5c09eb8722f3102f65b9a2e9f",
    "contentSha256": "2ccdf60eeac385667831c302bed7b356007f214747b27673885fb0b0187f8023"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/38-000025598869.json",
    "fileSha256": "517fd3058213c5977f856612bf7465d5c826b968342e2062ebd5519e4a9e35a8",
    "contentSha256": "104bd100afbd9e24de4719cbd2172cfb4de992f1fe97cd8b82466bdc8a0928f2"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/38-000025670641.json",
    "fileSha256": "a37271153827f51adba5a02e96b6cec5f84eaaa297f708bb43b7dbc97f19ca6f",
    "contentSha256": "5523c00909e7f850f9aaff97b8ed2e135ddee4faf36dc87f2fe9816ccc7df952"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/38-000025742366.json",
    "fileSha256": "6e31c92fb978457d8b98fa18fd0bfb597b2f087732320a024b716a4a8fa9c7ac",
    "contentSha256": "2e6fd079601189f5bbe784dc7d96c490aaffa33dcdd2685dd4cc9df81003f89d"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/38-000025814126.json",
    "fileSha256": "07a9b43afd844e014e49b57fdb33ada0a6bd2f4fafc95591ca26f6d70a059d54",
    "contentSha256": "0e347eb8dccdf044a8809c71ddefaa69f23e3808f2c7b93ce354044e5d503aa3"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/38-000025846412.json",
    "fileSha256": "f461d0b882167d2112f55e7d935ac4440de71fc77342f7a4c72361d9f2eea761",
    "contentSha256": "b485cb18d9cbd254d1a789bc9f4b98c7cf3a3804d8eacedb223e9536c274362f"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/38-000025885878.json",
    "fileSha256": "22486ffe028a230fe76ac93dc77ccf4c0b45824392bd3587f06d95afe425f64f",
    "contentSha256": "5e50fa1b44d113e125367f5bef3af6696cfc462b6232f1d93ff4f6932df93f51"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/38-000025957605.json",
    "fileSha256": "ae5cae8a325fe1a8a48facd5ef5cae69f3c84fac0067cee76975fe19e56f4035",
    "contentSha256": "318b01a3af1e484eb8e902ba262ff7486cf681641c98a88f3d5f0cb320cffbae"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/38-000026029315.json",
    "fileSha256": "4fbc37b4289099859add41d8c03c6c30f624e4f56a4023debe96b192245570c0",
    "contentSha256": "0074714d8d61f4cffc8adff99305ba2c1e873a964489fea1d95e9b142a98d79b"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/39-000025240302.json",
    "fileSha256": "fb74ba48b180edb016f6ffb7c295d98c290281236e4730d64fa2338764b085a4",
    "contentSha256": "4e1ee13ecb90809122e7e9d3f3e2297f79f5165948d5a1b956bfc9614b7df59c"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/40-000025240302.json",
    "fileSha256": "b818f5560be92637c6c4d5345a6a28324da9f370d9bbf9ff3fad80e550d04866",
    "contentSha256": "a033ee91e3ee17ec73d3bc2e7db5a63ec97645069b8168ab20d94be9b38ae7c7"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/41-000025240302.json",
    "fileSha256": "2e2c764c73ed43fe890b8002d33b2af64fe32095be67d731fcf13a6881aa2bb4",
    "contentSha256": "5b6425cad8082a851e9a343cb18188ff64165266dde000079d99c5aeb5a58d15"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/42-000025240302.json",
    "fileSha256": "f6a70136daf70929fc00f22fcc9031999e659d90ae90a36d64def30e1f5e5ed5",
    "contentSha256": "72239e42ca0d85588772f5415600d58ce0a0f4665b78a8721f4ea4228612d6a2"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/43-000025240302.json",
    "fileSha256": "d37a2a5ee9de64e46e1d7eda391dbff8ca48700b096d92bfc02767168f70f545",
    "contentSha256": "aab6618146ad105b2fbc217c9ba419559456e820f7315742965600a2d8fb65b4"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/44-000025240302.json",
    "fileSha256": "4f76625e61abbac8293f40dc0ad741c6ea28357993c4354c464cce100823f568",
    "contentSha256": "fb83cf5fa33411484628631fad18f5a43c852d06089ecf0ff517ae7a35e40a03"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/45-000025240302.json",
    "fileSha256": "f70138fb307263fa2bce7e39bb1e59874b415306b2702117ae3310d1600a8666",
    "contentSha256": "f9a7763c5feb7556de832cf3a4ceaa0ba1ae839cc7eb6a67ad3729657bf6b0e0"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/46-000025240302.json",
    "fileSha256": "ad48d30875c1668a9eea372529bf2c1d8787c9c08ab457447578ced4f5ec0d0f",
    "contentSha256": "e5a92914a32335a57b009a33085c04aa51e2b75cfb99e50c001b16dea1dd04a9"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/47-000025240302.json",
    "fileSha256": "1bdd48245f2f45b90b014543985cfbf1acf2f64b99951781c35a369ccc4e7c17",
    "contentSha256": "829b5eeda42b89f00124c2898de96d8449b903be086eb169ba92cb9cc2dd67f3"
  },
  {
    "path": "data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1/48-000025240302.json",
    "fileSha256": "f23d14c45d6d942d67dd991f4ea5f5bc47c310d18012eeee2c5aff836b8420a9",
    "contentSha256": "a3c6308db6fe760e3b9f6bd944908b098498f9cedc09633b05595f42c9358342"
  }
,
  { path: 'data/research/venue-signals/retrospective-native-funding-backtest-2026-10-08T02-34-33-final.json', fileSha256: 'b3d1bd6359b521d4bf2d144bc703ea8b3834df92ce6ffa7203e3c26bdf5543be', contentSha256: '532e33b079583ed318054b38cd410e58b11da5efd352e80102a87c3ccbf09196', sealField: 'bodySha256' }
].map(Object.freeze))
const MAX_INPUT_BYTES = 9 * 1024 * 1024
const MAX_REPORT_BYTES = 2 * 1024 * 1024
const RESERVE_BYTES = 256n * 1024n ** 2n
const check = (ok, reason) => { if (!ok) throw Error(reason) }
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const seal = (value) => ({ ...value, sha256: digest(value) })
const uint = (v) => typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < (1n << 256n)
const utc = (v) => typeof v === 'string' && Number.isSafeInteger(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v
function verifySeal(value) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'missing_object')
  const { sha256, ...body } = value
  check(/^[a-f0-9]{64}$/.test(sha256 ?? '') && digest(body) === sha256, 'seal_integrity')
}
export function readPinnedInput(root, pin) {
  const fd = openSync(resolve(root, pin.path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd)
    check(before.isFile() && before.size > 0 && before.size <= MAX_INPUT_BYTES && before.nlink === 1, 'input_size_or_kind')
    const bytes = readFileSync(fd), after = fstatSync(fd)
    check(bytes.length === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.ino === after.ino, 'input_changed')
    check(createHash('sha256').update(bytes).digest('hex') === pin.fileSha256, 'input_file_hash')
    const value = JSON.parse(bytes.toString('utf8'))
    const field = pin.sealField ?? 'sha256'
    const { [field]: contentHash, ...body } = value
    check(contentHash === pin.contentSha256 && digest(body) === contentHash, 'input_content_pin')
    return value
  } finally { closeSync(fd) }
}
export function loadRetainedInputs(root = process.cwd()) {
  const values = INPUT_PINS.map((pin) => readPinnedInput(root, pin))
  return { grid: values[0], records: values.slice(1, -1), cash: values.at(-1), provenance: INPUT_PINS }
}
function replayHeader(anchor, baseline, targetAt) {
  const d = anchor?.canonicalityEvidenceDoc
  check(d?.schema === 'carry_exit_v2_headers_v1' && d.chainId === '1' && d.finalityTag === 'finalized', 'header_schema')
  const t = d.targetHeader, p = d.parentHeader, b = d.baselineHeader, f = d.finalizedHead
  check(t?.number === anchor.targetBlock && t.hash === anchor.targetHash && t.timestamp === anchor.targetBlockAt && p?.number === anchor.targetParentBlock && p.hash === anchor.targetParentHash && p.timestamp === anchor.targetParentBlockAt, 'header_summary')
  check([t, p, b, f].every((h) => h && uint(h.number) && /^0x[0-9a-f]{64}$/.test(h.hash ?? '') && /^0x[0-9a-f]{64}$/.test(h.parentHash ?? '') && utc(h.timestamp)), 'header_fields')
  check(BigInt(p.number) + 1n === BigInt(t.number) && t.parentHash === p.hash && Date.parse(p.timestamp) < Date.parse(t.timestamp) && BigInt(f.number) >= BigInt(t.number) && Date.parse(f.timestamp) >= Date.parse(t.timestamp), 'header_order')
  check(utc(d.observedAt) && Date.parse(d.observedAt) >= Date.parse(f.timestamp) && d.observedAt === anchor.targetObservedAt && d.targetAt === targetAt, 'header_clock')
  if (baseline) check(b.number === baseline.targetBlock && b.hash === baseline.targetHash && b.timestamp === baseline.targetBlockAt && Date.parse(p.timestamp) < Date.parse(targetAt) && Date.parse(t.timestamp) >= Date.parse(targetAt), 'future_first_block')
  else check(equal(b, p) && targetAt === t.timestamp, 'source_header_baseline')
  return new URL(d.provider).hostname
}
function replayAnchor(pair, baseline, targetAt) {
  const a = replayHeader(pair.primary, baseline, targetAt), b = replayHeader(pair.secondary, baseline, targetAt)
  check(a !== b, 'header_origins_not_independent')
}
export function replayAssay(record, anchor, assay) {
  const proof = assay.evidence
  const frozen = { routeKey: record.routeKey, destination: record.destination, asset: record.asset, holder: record.holder, assetsRaw: record.assetsRaw, blockNumber: anchor.targetBlock, blockHash: anchor.targetHash }
  const decoded = validateCarryExitV2RpcProof({ proof, ...frozen })
  const collector = { status: 'raw_rpc_collected', proof, blockNumber: frozen.blockNumber, blockHash: frozen.blockHash, routeKind: decoded.routeKind, provider: proof.holderCoverageRpc.provider, source: proof.holderCoverageRpc.source, identityEvidence: proof.identityEvidence }
  assembleCarryExitV2CallEvidence({ collector, replay: { status: 'verified', verdict: decoded, replayEvidenceDoc: proof.replayEvidenceDoc }, frozen })
  check(proof.verificationStatus === 'verified', 'assay_verification_status')
  for (const origin of ['primary', 'secondary']) for (const when of ['before', 'after']) {
    const h = proof.replayEvidenceDoc.headers[origin][when].target
    check(new Date(Number(BigInt(h.timestamp)) * 1000).toISOString() === anchor.targetBlockAt, 'assay_header_time')
  }
  return { source: { blockNumber: anchor.targetBlock, blockHash: anchor.targetHash, blockTime: anchor.targetBlockAt }, sharesRaw: decoded.holderSharesRaw, shareDecimals: null, fullEntitlementRaw: decoded.previewRedeemAssetsRaw, frozenRequestedQRaw: record.assetsRaw, entitlementHeadroomRaw: (BigInt(decoded.previewRedeemAssetsRaw) - BigInt(record.assetsRaw)).toString(), qEntitlementCovered: BigInt(decoded.previewRedeemAssetsRaw) >= BigInt(record.assetsRaw), exactQWithdrawSimulation: decoded.simulationStatus, sharesBurnedRaw: decoded.sharesBurnedRaw, fullEntitlementMethod: 'balanceOf_owner_then_previewRedeem_entire_balance', independentOfRequestedQ: true, protocolCapacityRaw: null, queueMRaw: null }
}
export function foldPair(record) {
  validateRecord(record)
  replayAnchor(record.source, null, record.source.primary.targetBlockAt)
  check(utc(record.capturedAtUtc) && Date.parse(record.capturedAtUtc) >= Date.parse(record.source.primary.targetBlockAt), 'capture_clock')
  const identity = { routeIndex: record.routeIndex, routeKey: record.routeKey, destination: record.destination, asset: record.asset, assetDecimals: record.sourceState?.assetDecimals ?? null, owner: record.holder, frozenRequestedQRaw: record.assetsRaw, sourceBlock: record.sourceBlock, originalRecordSha256: record.sha256 }
  if (!record.holder) return { ...identity, status: 'excluded', reason: record.sourceAssay.reason, source: null, outcome: null }
  check(Number.isSafeInteger(identity.assetDecimals) && identity.assetDecimals >= 0 && identity.assetDecimals <= 36, 'native_decimals')
  replayAnchor(record.future, record.source.primary, record.targetAtUtc)
  check(Date.parse(record.capturedAtUtc) >= Date.parse(record.future.primary.targetBlockAt), 'capture_outcome_clock')
  const source = record.sourceAssay.status === 'verified' ? replayAssay(record, record.source.primary, record.sourceAssay) : null
  const outcome = record.futureAssay.status === 'verified' ? replayAssay(record, record.future.primary, record.futureAssay) : null
  if (!source || !outcome) return { ...identity, status: 'excluded', reason: 'missing_native_assay_prong', source, outcome }
  const elapsedSeconds = (Date.parse(outcome.source.blockTime) - Date.parse(source.source.blockTime)) / 1000
  check(Number.isSafeInteger(elapsedSeconds) && elapsedSeconds > 0, 'elapsed_clock')
  check(source.sharesRaw === record.candidate.selectedSharesRaw && source.fullEntitlementRaw === record.candidate.selectedClaimRaw, 'source_discovery_full_position_binding')
  const sameShares = source.sharesRaw === outcome.sharesRaw
  const delta = BigInt(outcome.fullEntitlementRaw) - BigInt(source.fullEntitlementRaw)
  const error = -delta
  return { ...identity, status: 'retained_full_holder_pair', reason: null, sharesUnchanged: sameShares, driftStatus: sameShares ? 'same_share_balance_endpoint_comparison' : 'censored_share_balance_changed', source, outcome, elapsedSeconds,
    fullEntitlementDeltaRaw: delta.toString(),
    persistence: sameShares ? { model: 'unchanged_full_entitlement_and_entitlement_headroom', sourceOnly: true, retrospective: true, predictedFullEntitlementRaw: source.fullEntitlementRaw, observedFullEntitlementRaw: outcome.fullEntitlementRaw, predictedEntitlementHeadroomRaw: source.entitlementHeadroomRaw, observedEntitlementHeadroomRaw: outcome.entitlementHeadroomRaw, signedErrorRaw: error.toString(), absoluteErrorRaw: (error < 0n ? -error : error).toString(), errorConvention: 'forecast_minus_observed', capacityForecast: null } : null,
    sampledAbility: { source: source.exactQWithdrawSimulation, target: outcome.exactQWithdrawSimulation, onlyFrozenQ: true, fullEaWithdrawSimulated: false, minedPaymentObserved: false },
    duration: { continuousAvailabilitySeconds: null, continuousAvailability: 'unknown_between_samples', restrictionTime: null, recoveryTime: null, censoring: 'two_endpoint_samples_only' }, queue: { MRaw: null, semantics: 'unknown_unattested', zeroAssumed: false }, protocol: { capacityRaw: null, competingFlowRaw: null, asofProcess: 'missing', idleCashIsWholeCapacity: false, capacityProbability: null },
  }
}
export function buildBacktest(inputs, analysisAt) {
  check(utc(analysisAt) && analysisAt.startsWith('2026-10-08T'), 'analysis_clock')
  check(equal(inputs.provenance, INPUT_PINS), 'manifest_binding')
  const { grid, records, cash } = inputs
  verifySeal(grid)
  const { bodySha256, ...cashBody } = cash ?? {}
  check(bodySha256 === INPUT_PINS.at(-1).contentSha256 && digest(cashBody) === bodySha256 && cash.scope === 'funding_only', 'cash_pin')
  check(grid.sha256 === INPUT_PINS[0].contentSha256 && grid.historicalBacktestOnly === true && grid.forecastValidated === false && grid.study === 'carry_morpho_retrospective_grid_v1', 'grid_pin')
  check(Array.isArray(records) && records.length === INPUT_PINS.length - 2, 'record_cohort_size')
  for (const [i, record] of records.entries()) {
    verifySeal(record)
    check(record.sha256 === INPUT_PINS[i + 1].contentSha256, 'record_cohort_pin')
    check(Date.parse(record.capturedAtUtc) <= Date.parse(analysisAt), 'analysis_before_capture')
  }
  check(BOARD_ROUTES.length === 49 && grid.cells.length === 588, 'roster_size')
  const coverage = BOARD_ROUTES.map((route, routeIndex) => {
    const cells = grid.cells.filter((c) => c.routeIndex === routeIndex)
    check(cells.length === 12 && cells.every((c) => c.routeKey === route.routeKey && c.destination === route.destination && c.asset === route.asset), 'roster_grid_binding')
    const histories = cash.historyResults.filter((h) => h.identity.routeKey === route.routeKey && h.identity.destination === route.destination && h.identity.asset === route.asset)
    check(histories.length === 1 && histories[0].scope === 'native_cash_only_not_holder' && Number.isSafeInteger(histories[0].pointCount) && histories[0].pointCount > 0 && histories[0].pointCount <= 120 && Number.isSafeInteger(histories[0].identity.assetDecimals) && histories[0].identity.assetDecimals >= 0 && histories[0].identity.assetDecimals <= 36, 'native_cash_roster_binding')
    const history = histories[0]
    return { routeIndex, routeKey: route.routeKey, destination: route.destination, asset: route.asset, assetDecimals: history.identity.assetDecimals, historicalNativeCash: { pointCount: history.pointCount, scope: history.scope, witness: history.witness, reportBodySha256: cash.bodySha256, status: 'retained_pinned_summary_only_not_raw_cash_replay' }, historicalCashGridAnchors: 12, capturedPairRecords: records.filter((r) => r.routeIndex === routeIndex).length }
  })
  const pairs = records.map(foldPair)
  for (const pair of pairs) check(pair.assetDecimals === null || pair.assetDecimals === coverage[pair.routeIndex].assetDecimals, 'pair_native_cash_decimals_binding')
  const retained = pairs.filter((p) => p.status === 'retained_full_holder_pair')
  for (const row of coverage) {
    row.retainedFullHolderPairs = retained.filter((p) => p.routeIndex === row.routeIndex).length
    row.exclusions = pairs.filter((p) => p.routeIndex === row.routeIndex && p.status === 'excluded').map((p) => ({ sourceBlock: p.sourceBlock, reason: p.reason }))
    row.holderEvidence = row.retainedFullHolderPairs ? 'retained_native_pairs' : 'missing_retained_full_holder_prongs'
  }
  return seal({ schema: SCHEMA, analysisAt, status: 'retrospective_full_entitlement_persistence_fold', inputManifest: INPUT_PINS, inputManifestSha256: digest(INPUT_PINS), coverage, pairs,
    scope: { rosterDestinations: 49, retainedRecords: records.length, verifiedAssayPairs: pairs.filter((p) => p.source && p.outcome).length, retainedFullHolderPairs: retained.length, unchangedFullHolderPairs: retained.filter((p) => p.sharesUnchanged).length, shareChangedPairs: retained.filter((p) => !p.sharesUnchanged).length, fundedDestinations: new Set(retained.map((p) => p.destination)).size, fundedNativeAssets: [...new Set(retained.map((p) => p.asset))].sort(), casesAreCorrelated: true, all49HolderQualification: false },
    interpretation: { fullEaIndependentOfQ: true, headroomMeans: 'full_entitlement_minus_original_frozen_Q_only', headroomIsExecutableCapacity: false, protocolCapacity: 'unknown_missing_adapter_and_asof_flow_prongs', M: 'unknown_not_zero', cashGridIsFundedHolderProof: false, prospectiveAccuracyValidated: false, forecastProbability: null, continuousAvailability: 'unknown_between_samples', executionObserved: false, minedPaymentObserved: false, furtherNativeAssetsFunded: false, shareChangedPairDrift: 'censored_balance_change_not_accrual_only', unchangedSharesBetweenEndpoints: 'not_proved_continuously' } })
}
export function writeReportExclusive(path, report) {
  verifySeal(report)
  check(report.schema === SCHEMA && equal(report.inputManifest, INPUT_PINS), 'report_identity')
  const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n')
  check(bytes.length <= MAX_REPORT_BYTES, 'report_oversize')
  const disk = statfsSync(dirname(resolve(path)), { bigint: true })
  check(disk.bavail * disk.bsize - BigInt(bytes.length) >= RESERVE_BYTES, 'disk_reserve')
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  return { path: resolve(path), bytes: bytes.length, fileSha256: createHash('sha256').update(bytes).digest('hex'), contentSha256: report.sha256 }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, analysisAt, output = OUTPUT] = process.argv.slice(2)
    check(mode === 'verify' || mode === 'write', 'usage_verify_or_write_analysisAt_output')
    const report = buildBacktest(loadRetainedInputs(), analysisAt)
    if (mode === 'write') console.log(JSON.stringify(writeReportExclusive(output, report)))
    else console.log(JSON.stringify({ schema: report.schema, sha256: report.sha256, scope: report.scope }))
  } catch (error) { console.error('morpho_retained_backtest_' + error.message); process.exitCode = 1 }
}
