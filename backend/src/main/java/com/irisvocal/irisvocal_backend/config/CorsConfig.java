
package com.irisvocal.irisvocal_backend.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import java.util.List;

@Configuration
public class CorsConfig {

    @Bean
    //We configure CORS to tell the browser which cross-origin requests are allowed.
    public CorsConfigurationSource corsConfigurationSource() {

        CorsConfiguration config = new CorsConfiguration();

        // Allow our React frontend
        config.setAllowedOrigins(
                List.of("http://localhost:5173")
        );

        // Allow the required HTTP methods
        config.setAllowedMethods(
                List.of("GET", "POST", "PUT", "DELETE", "OPTIONS")
        );

        // Allow JSON requests and the CSRF token header
        config.setAllowedHeaders(
                List.of("Content-Type", "X-XSRF-TOKEN")
        );

        // Allow session cookies to be sent
        config.setAllowCredentials(true);
//its job is to associate CORS rules with URL paths
        UrlBasedCorsConfigurationSource source =
                new UrlBasedCorsConfigurationSource();

        source.registerCorsConfiguration("/**", config);

        //makes the configured source available to Spring Security through your @Bean method.
        return source;
    }
}

