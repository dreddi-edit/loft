import "@/App.css";
import { BrowserRouter } from "react-router-dom";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { Toaster } from "@/components/ui/sonner";
import Navbar from "@/components/Navbar";
import Hero from "@/components/Hero";
import About from "@/components/About";
import Spaces from "@/components/Spaces";
import Events from "@/components/Events";
import Amenities from "@/components/Amenities";
import Gallery from "@/components/Gallery";
import Pricing from "@/components/Pricing";
import Booking from "@/components/Booking";
import Contact from "@/components/Contact";
import Footer from "@/components/Footer";

function App() {
  return (
    <LanguageProvider>
      <BrowserRouter>
        <div className="App font-body">
          <Navbar />
          <Hero />
          <About />
          <Spaces />
          <Events />
          <Amenities />
          <Gallery />
          <Pricing />
          <Booking />
          <Contact />
          <Footer />
          <Toaster position="bottom-right" />
        </div>
      </BrowserRouter>
    </LanguageProvider>
  );
}

export default App;
